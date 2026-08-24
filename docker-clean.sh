#!/usr/bin/env bash

echo "⚠️ Warning: This will forcefully destroy ALL Docker data!"
echo "Stopping all active containers..."
docker stop $(docker ps -aq) 2>/dev/null || true

echo "Removing all containers..."
docker rm -f $(docker ps -aq) 2>/dev/null || true

echo "Removing all images..."
docker rmi -f $(docker images -aq) 2>/dev/null || true

echo "Removing all custom networks..."
docker network rm $(docker network ls -q) 2>/dev/null || true

echo "System prune (Volumes, Cache, and Leftovers)..."
docker system prune -a --volumes -f

echo "✨ Docker host has been completely cleared!"
