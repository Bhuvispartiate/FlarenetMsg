#!/bin/bash
set -e

if [ -z "$1" ]; then
    echo "Usage: sudo ./setup-ssl.sh <your-domain>"
    echo "Example: sudo ./setup-ssl.sh wa.yourdomain.com"
    exit 1
fi

DOMAIN=$1

echo "=== Setting up Nginx and Free SSL for $DOMAIN ==="

# 1. Install Nginx and Certbot
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx

# 2. Write Nginx Reverse Proxy Configuration
cat <<EOF | sudo tee /etc/nginx/sites-available/$DOMAIN
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

# 3. Enable site and test Nginx
sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# 4. Obtain and configure Let's Encrypt SSL
echo "Requesting SSL certificate..."
sudo certbot --nginx -d $DOMAIN --agree-tos --register-unsafely-without-email --non-interactive --redirect

echo ""
echo "================================================="
echo " SSL Certificate successfully installed!"
echo " Visit: https://$DOMAIN"
echo "================================================="
