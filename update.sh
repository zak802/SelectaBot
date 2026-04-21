#!/bin/bash
# SelectaBot Update Script
# Pulls latest stable release from upstream and restarts

set -e

echo "🔄 Updating SelectaBot..."

# Check we're in the right directory
if [ ! -f "bot.js" ]; then
  echo "❌ Run this from the SelectaBot directory"
  exit 1
fi

# Store current version for changelog
PREV=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Pull latest from main (stable releases only)
git pull origin main

# Show what changed
NEW=$(git rev-parse HEAD 2>/dev/null)
if [ "$PREV" != "$NEW" ]; then
  echo ""
  echo "📋 Changes:"
  git log --oneline "$PREV".."$NEW" 2>/dev/null || echo "  (first install)"
  echo ""
  
  # Reinstall deps if package.json changed
  if git diff "$PREV" "$NEW" --name-only 2>/dev/null | grep -q "package.json"; then
    echo "📦 Updating dependencies..."
    npm install
  fi
  
  # Restart bot
  if command -v pm2 &>/dev/null; then
    pm2 restart selectabot 2>/dev/null || pm2 start bot.js --name selectabot
    echo "✅ SelectaBot updated and restarted"
  else
    echo "⚠️  Restart your bot manually: node bot.js"
  fi
else
  echo "✅ Already up to date"
fi
