package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// ==========================================
// WhatsApp Instance Manager
// ==========================================

type WhatsAppManager struct {
	client       *whatsmeow.Client
	mu           sync.RWMutex
	currentQR    string
	currentRawQR string
	status       string // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
	instanceName string
	connectedJID string
	startTime    time.Time
	isStarting   bool
	im           *InstanceManager
	apiKey       string
}

type InstanceManager struct {
	instances map[string]*WhatsAppManager
	mu        sync.RWMutex
	db        *sql.DB
	container *sqlstore.Container
}

func NewInstanceManager(dbURL string) (*InstanceManager, error) {
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS wa_instances (
		name VARCHAR(255) PRIMARY KEY,
		jid VARCHAR(255) NOT NULL,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		return nil, fmt.Errorf("failed to create instances table: %w", err)
	}
	_, _ = db.Exec(`ALTER TABLE wa_instances ADD COLUMN IF NOT EXISTS api_key VARCHAR(255)`)

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS wa_message_logs (
		id SERIAL PRIMARY KEY,
		instance_name VARCHAR(255),
		recipient VARCHAR(255),
		message TEXT,
		status VARCHAR(50),
		message_id VARCHAR(255),
		timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		return nil, fmt.Errorf("failed to create logs table: %w", err)
	}

	dbLog := waLog.Stdout("WhatsApp-Store", "WARN", true)
	container, err := sqlstore.New(context.Background(), "postgres", dbURL, dbLog)
	if err != nil {
		return nil, fmt.Errorf("failed to create whatsmeow store: %w", err)
	}

	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()
	store.DeviceProps.Os = proto.String("Chrome (Windows)")
	store.DeviceProps.RequireFullSync = proto.Bool(false)
	store.DeviceProps.HistorySyncConfig = &waCompanionReg.DeviceProps_HistorySyncConfig{
		FullSyncDaysLimit:   proto.Uint32(0),
		FullSyncSizeMbLimit: proto.Uint32(0),
		StorageQuotaMb:      proto.Uint32(0),
	}

	return &InstanceManager{
		instances: make(map[string]*WhatsAppManager),
		db:        db,
		container: container,
	}, nil
}

func (im *InstanceManager) LoadInstances() error {
	rows, err := im.db.Query("SELECT name, jid, api_key FROM wa_instances")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var name, jid string
		var apiKey sql.NullString
		if err := rows.Scan(&name, &jid, &apiKey); err != nil {
			continue
		}

		parsedJID, err := types.ParseJID(jid)
		if err != nil {
			continue
		}

		device, err := im.container.GetDevice(context.Background(), parsedJID)
		if err != nil || device == nil {
			continue
		}

		wm := &WhatsAppManager{
			instanceName: name,
			status:       "DISCONNECTED",
			startTime:    time.Now(),
			im:           im,
			apiKey:       apiKey.String,
		}

		clientLog := waLog.Stdout("WhatsApp-Client-"+name, "WARN", true)
		client := whatsmeow.NewClient(device, clientLog)
		client.AddEventHandler(wm.eventHandler)
		wm.client = client
		wm.connectedJID = parsedJID.String()

		im.mu.Lock()
		im.instances[name] = wm
		im.mu.Unlock()

		go wm.Start(false)
	}
	
	if err := rows.Err(); err != nil {
		return err
	}
	
	return nil
}

func (im *InstanceManager) GetInstance(name string) *WhatsAppManager {
	im.mu.RLock()
	defer im.mu.RUnlock()
	return im.instances[name]
}

func (im *InstanceManager) CreateInstance(name, apiKey string) (*WhatsAppManager, error) {
	im.mu.Lock()
	defer im.mu.Unlock()

	if _, exists := im.instances[name]; exists {
		return nil, fmt.Errorf("instance '%s' already exists", name)
	}

	device := im.container.NewDevice()
	wm := &WhatsAppManager{
		instanceName: name,
		status:       "DISCONNECTED",
		startTime:    time.Now(),
		im:           im,
		apiKey:       apiKey,
	}

	clientLog := waLog.Stdout("WhatsApp-Client-"+name, "WARN", true)
	client := whatsmeow.NewClient(device, clientLog)
	client.AddEventHandler(wm.eventHandler)
	wm.client = client

	im.instances[name] = wm
	return wm, nil
}

func (im *InstanceManager) DeleteInstance(name string) error {
	im.mu.Lock()
	defer im.mu.Unlock()

	wm, exists := im.instances[name]
	if !exists {
		return fmt.Errorf("instance '%s' not found", name)
	}

	if wm.client != nil {
		wm.client.Disconnect()
		if wm.client.Store != nil && wm.client.Store.ID != nil {
			_ = wm.client.Store.Delete(context.Background())
		}
	}

	_, _ = im.db.Exec("DELETE FROM wa_instances WHERE name = $1", name)
	delete(im.instances, name)
	return nil
}

func (im *InstanceManager) GetAllStatuses() []map[string]interface{} {
	im.mu.RLock()
	defer im.mu.RUnlock()

	var result []map[string]interface{}
	for name, wm := range im.instances {
		wm.mu.RLock()
		result = append(result, map[string]interface{}{
			"name":      name,
			"status":    wm.status,
			"connected": wm.status == "CONNECTED",
			"loggedIn":  wm.connectedJID != "",
			"phone":     wm.connectedJID,
			"uptime":    time.Since(wm.startTime).String(),
			"api_key":   wm.apiKey,
		})
		wm.mu.RUnlock()
	}
	if result == nil {
		result = make([]map[string]interface{}, 0)
	}
	return result
}

// ==========================================
// Instance Logic
// ==========================================

func (wm *WhatsAppManager) Start(forceNewPairing bool) error {
	wm.mu.Lock()
	if wm.isStarting {
		wm.mu.Unlock()
		return nil
	}

	if wm.client != nil && wm.client.IsConnected() {
		wm.status = "CONNECTED"
		if wm.client.Store.ID != nil {
			wm.connectedJID = wm.client.Store.ID.String()
		}
		wm.mu.Unlock()
		return nil
	}

	wm.isStarting = true
	wm.status = "CONNECTING"
	if wm.client != nil {
		wm.client.Disconnect()
	}
	wm.mu.Unlock()

	defer func() {
		wm.mu.Lock()
		wm.isStarting = false
		wm.mu.Unlock()
	}()

	if wm.client.Store.ID != nil && !forceNewPairing {
		err := wm.client.Connect()
		if err != nil {
			fmt.Printf("[WA] Instance '%s' reconnection error: %v\n", wm.instanceName, err)
			return err
		}
		wm.mu.Lock()
		wm.status = "CONNECTED"
		wm.connectedJID = wm.client.Store.ID.String()
		wm.currentQR = ""
		wm.currentRawQR = ""
		wm.mu.Unlock()
	} else {
		qrChan, _ := wm.client.GetQRChannel(context.Background())
		err := wm.client.Connect()
		if err != nil {
			wm.mu.Lock()
			wm.status = "DISCONNECTED"
			wm.mu.Unlock()
			return fmt.Errorf("failed to connect whatsapp socket: %w", err)
		}

		go func() {
			for evt := range qrChan {
				switch evt.Event {
				case "code":
					wm.mu.Lock()
					wm.currentRawQR = evt.Code
					pngBytes, err := qrcode.Encode(evt.Code, qrcode.Medium, 256)
					if err == nil {
						wm.currentQR = "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)
						wm.status = "QR_READY"
					}
					wm.mu.Unlock()
				case "timeout":
					wm.mu.Lock()
					wm.currentQR = ""
					wm.currentRawQR = ""
					if wm.status != "CONNECTED" {
						wm.status = "DISCONNECTED"
					}
					wm.mu.Unlock()
					return
				case "success":
					wm.mu.Lock()
					wm.status = "CONNECTED"
					wm.currentQR = ""
					wm.currentRawQR = ""
					if wm.client != nil && wm.client.Store.ID != nil {
						wm.connectedJID = wm.client.Store.ID.String()
						_, _ = wm.im.db.Exec("INSERT INTO wa_instances (name, jid, api_key) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET jid = EXCLUDED.jid, api_key = EXCLUDED.api_key", wm.instanceName, wm.connectedJID, wm.apiKey)
					}
					wm.mu.Unlock()
				}
			}
		}()
	}

	return nil
}

func (wm *WhatsAppManager) eventHandler(evt interface{}) {
	switch v := evt.(type) {
	case *events.Connected:
		wm.mu.Lock()
		if wm.client != nil && wm.client.Store.ID != nil {
			wm.status = "CONNECTED"
			wm.connectedJID = wm.client.Store.ID.String()
			wm.currentQR = ""
			wm.currentRawQR = ""
			_, _ = wm.im.db.Exec("INSERT INTO wa_instances (name, jid, api_key) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET jid = EXCLUDED.jid, api_key = EXCLUDED.api_key", wm.instanceName, wm.connectedJID, wm.apiKey)
		}
		wm.mu.Unlock()

	case *events.PairSuccess:
		wm.mu.Lock()
		wm.status = "CONNECTED"
		if wm.client != nil && wm.client.Store.ID != nil {
			wm.connectedJID = wm.client.Store.ID.String()
			_, _ = wm.im.db.Exec("INSERT INTO wa_instances (name, jid, api_key) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET jid = EXCLUDED.jid, api_key = EXCLUDED.api_key", wm.instanceName, wm.connectedJID, wm.apiKey)
		}
		wm.currentQR = ""
		wm.currentRawQR = ""
		wm.mu.Unlock()

	case *events.Receipt:
		status := ""
		switch v.Type {
		case events.ReceiptTypeDelivered:
			status = "DELIVERED"
		case events.ReceiptTypeRead, events.ReceiptTypeReadSelf:
			status = "READ"
		}
		if status != "" {
			for _, msgID := range v.MessageIDs {
				_, _ = wm.im.db.Exec("UPDATE wa_message_logs SET status = $1 WHERE message_id = $2", status, msgID)
			}
		}

	case *events.LoggedOut:
		wm.mu.Lock()
		wm.status = "DISCONNECTED"
		wm.connectedJID = ""
		wm.currentQR = ""
		wm.currentRawQR = ""
		wm.mu.Unlock()
		_, _ = wm.im.db.Exec("DELETE FROM wa_instances WHERE name = $1", wm.instanceName)
		fmt.Printf("[WA] Instance '%s' Logged Out: %v\n", wm.instanceName, v.Reason)

	case *events.Disconnected:
		if wm.client != nil && wm.client.Store.ID != nil {
			go func() {
				time.Sleep(1 * time.Second)
				wm.mu.RLock()
				c := wm.client
				wm.mu.RUnlock()
				if c != nil && !c.IsConnected() && c.Store.ID != nil {
					_ = c.Connect()
				}
			}()
		}

	}
}

func (wm *WhatsAppManager) SendTextMessage(phone string, message string) (string, error) {
	wm.mu.RLock()
	client := wm.client
	wm.mu.RUnlock()

	if client == nil {
		return "", fmt.Errorf("whatsapp instance '%s' is not initialized", wm.instanceName)
	}

	if client.Store.ID == nil {
		return "", fmt.Errorf("whatsapp instance '%s' is not paired", wm.instanceName)
	}

	if !client.IsConnected() {
		_ = client.Connect()
		for i := 0; i < 8; i++ {
			if client.IsConnected() {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if !client.IsConnected() {
			return "", fmt.Errorf("whatsapp instance '%s' is reconnecting, please retry later", wm.instanceName)
		}
	}

	cleanPhone := regexp.MustCompile("[^0-9]").ReplaceAllString(phone, "")
	cleanPhone = strings.TrimPrefix(cleanPhone, "0")
	if len(cleanPhone) == 10 {
		cleanPhone = "91" + cleanPhone
	}

	recipientJID := types.NewJID(cleanPhone, types.DefaultUserServer)

	msg := &waProto.Message{
		Conversation: proto.String(message),
	}

	resp, err := client.SendMessage(context.Background(), recipientJID, msg)
	if err != nil {
		return "", fmt.Errorf("failed to send message via WhatsApp: %w", err)
	}

	_, _ = wm.im.db.Exec("INSERT INTO wa_message_logs (instance_name, recipient, message, status, message_id) VALUES ($1, $2, $3, $4, $5)",
		wm.instanceName, cleanPhone, message, "SENT", resp.ID)

	return resp.ID, nil
}

// ==========================================
// REST API Server
// ==========================================

func AuthMiddleware(globalKey string, im *InstanceManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := ""
		authHeader := c.GetHeader("Authorization")
		if authHeader != "" {
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
				token = strings.TrimSpace(parts[1])
			} else {
				token = strings.TrimSpace(authHeader)
			}
		}
		if token == "" {
			token = c.GetHeader("apikey")
		}

		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "error": "API key required"})
			return
		}

		// Global Key check
		if subtle.ConstantTimeCompare([]byte(token), []byte(globalKey)) == 1 {
			c.Next()
			return
		}

		// Instance API Key check
		name := c.Param("name")
		if name != "" {
			wm := im.GetInstance(name)
			if wm != nil && wm.apiKey != "" && subtle.ConstantTimeCompare([]byte(token), []byte(wm.apiKey)) == 1 {
				// Restrict instance keys to specific external endpoints
				if strings.HasSuffix(c.Request.URL.Path, "/send/text") || strings.Contains(c.Request.URL.Path, "/status") {
					c.Next()
					return
				}
			}
		}

		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"success": false, "error": "Invalid API key"})
	}
}

func main() {
	_ = godotenv.Load(".env")

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	globalKey := os.Getenv("GLOBAL_API_KEY")
	if globalKey == "" {
		globalKey = "wa_global_secret_key_change_me_in_production"
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Println("[FATAL] DATABASE_URL is required")
		os.Exit(1)
	}

	im, err := NewInstanceManager(dbURL)
	if err != nil {
		fmt.Printf("[FATAL] Failed to initialize Instance Manager: %v\n", err)
		return
	}

	if err := im.LoadInstances(); err != nil {
		fmt.Printf("[WARN] Failed to load existing instances: %v\n", err)
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	r.StaticFile("/", "../index.html")
	r.StaticFile("/style.css", "../style.css")
	r.StaticFile("/app.js", "../app.js")

	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Origin, Content-Type, Authorization, apikey")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(200)
			return
		}
		c.Next()
	})

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	baseAPI := r.Group("/api/v1")
	
	baseAPI.POST("/auth/login", func(c *gin.Context) {
		var req struct {
			Username string `json:"username" binding:"required"`
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "Username and password required"})
			return
		}

		dashUser := os.Getenv("DASHBOARD_USER")
		dashPass := os.Getenv("DASHBOARD_PASS")

		if dashUser == "" || dashPass == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "Dashboard credentials not configured"})
			return
		}

		if subtle.ConstantTimeCompare([]byte(req.Username), []byte(dashUser)) == 1 &&
			subtle.ConstantTimeCompare([]byte(req.Password), []byte(dashPass)) == 1 {
			c.JSON(http.StatusOK, gin.H{"success": true, "token": globalKey})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "error": "Invalid credentials"})
	})

	api := baseAPI.Group("")
	api.Use(AuthMiddleware(globalKey, im))

	// Get Logs
	api.GET("/messages/logs", func(c *gin.Context) {
		rows, err := im.db.Query("SELECT instance_name, recipient, status, timestamp FROM wa_message_logs ORDER BY id DESC LIMIT 100")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
			return
		}
		defer rows.Close()

		var logs []map[string]interface{}
		for rows.Next() {
			var name, recip, status string
			var ts time.Time
			if err := rows.Scan(&name, &recip, &status, &ts); err == nil {
				logs = append(logs, map[string]interface{}{
					"instanceName": name,
					"number":       recip,
					"status":       status,
					"timestamp":    ts.Format(time.RFC3339),
				})
			}
		}
		
		if err := rows.Err(); err != nil {
			fmt.Printf("[ERROR] rows iteration error: %v\n", err)
		}
		
		if logs == nil {
			logs = make([]map[string]interface{}, 0)
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "data": logs})
	})

	instAPI := api.Group("/instances")
	// List all instances
	instAPI.GET("", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": im.GetAllStatuses()})
	})

	// Create/Start an instance
	type CreateInstReq struct {
		APIKey string `json:"api_key"`
	}
	instAPI.POST("/:name", func(c *gin.Context) {
		name := c.Param("name")
		var req CreateInstReq
		_ = c.ShouldBindJSON(&req)

		wm := im.GetInstance(name)
		if wm == nil {
			var err error
			wm, err = im.CreateInstance(name, req.APIKey)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
				return
			}
		}
		
		if wm.status == "DISCONNECTED" && !wm.isStarting {
			go func() { _ = wm.Start(false) }()
		}
		
		for i := 0; i < 40; i++ {
			wm.mu.RLock()
			st := wm.status
			qr := wm.currentQR
			wm.mu.RUnlock()
			
			if st == "CONNECTED" || qr != "" {
				c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"qrcode": qr}})
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": "Timeout waiting for QR code. Please try again."})
	})

	// View Instance QR
	instAPI.GET("/:name/qr", func(c *gin.Context) {
		name := c.Param("name")
		wm := im.GetInstance(name)
		if wm == nil {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "Instance not found"})
			return
		}

		wm.mu.RLock()
		st := wm.status
		qr := wm.currentQR
		code := wm.currentRawQR
		jid := wm.connectedJID
		isStarting := wm.isStarting
		wm.mu.RUnlock()

		if st == "CONNECTED" {
			c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"status": st, "phone": jid}})
			return
		}

		if qr == "" && st == "DISCONNECTED" && !isStarting {
			go func() { _ = wm.Start(false) }()
		}

		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"status": st, "qrcode": qr, "code": code}})
	})

	// Delete Instance
	instAPI.DELETE("/:name", func(c *gin.Context) {
		name := c.Param("name")
		err := im.DeleteInstance(name)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "message": "Instance deleted"})
	})

	// Status (Specific Instance)
	instAPI.GET("/:name/status", func(c *gin.Context) {
		name := c.Param("name")
		wm := im.GetInstance(name)
		if wm == nil {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "Instance not found"})
			return
		}
		wm.mu.RLock()
		defer wm.mu.RUnlock()
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"status": wm.status, "phone": wm.connectedJID}})
	})

	// Send Text Message
	type SendTextReq struct {
		Phone   string `json:"phone" binding:"required"`
		Message string `json:"message" binding:"required"`
	}
	instAPI.POST("/:name/send/text", func(c *gin.Context) {
		name := c.Param("name")
		wm := im.GetInstance(name)
		if wm == nil {
			c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "Instance not found"})
			return
		}

		var req SendTextReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": err.Error()})
			return
		}

		id, err := wm.SendTextMessage(req.Phone, req.Message)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"message_id": id}})
	})


	srv := &http.Server{Addr: ":" + port, Handler: r}
	go func() {
		fmt.Printf("[OK] API Server listening on port %s\n", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("[ERROR] Server error: %v\n", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	fmt.Println("[SHUTDOWN] Shutting down gracefully...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
