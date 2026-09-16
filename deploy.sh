#!/bin/bash
set -e

echo "=== Flarenet WhatsApp Automation EC2 Deploy Script ==="

# Check if docker is installed
if ! command -v docker &> /dev/null; then
    echo "[1/4] Installing Docker and Docker Compose..."
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo usermod -aG docker $USER
    echo "Docker installed successfully."
else
    echo "[1/4] Docker is already installed."
fi

# Ensure 2GB swap space exists on small instances to prevent out-of-memory errors
if [ $(swapon --show | wc -l) -le 1 ]; then
    echo "[2/4] Setting up 2GB Swap space for system stability..."
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "Swap configured."
else
    echo "[2/4] Swap space is already configured."
fi

# Check for .env file
if [ ! -f .env ] && [ ! -f api/.env ]; then
    echo "[3/4] Warning: No .env found. Creating .env from .env.example..."
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "Created .env. Please edit .env with your actual DATABASE_URL and credentials before starting!"
    fi
else
    echo "[3/4] Environment file detected."
fi

# Build and start container
echo "[4/4] Building and launching container..."
sudo docker compose up -d --build

echo "=== Deployment complete! ==="
echo "Container status:"
sudo docker compose ps
