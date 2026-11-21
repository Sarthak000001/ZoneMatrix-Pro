#!/usr/bin/env bash
# One-time setup for an Ubuntu EC2 instance. Run as the ubuntu user:
#   bash deploy/bootstrap-ec2.sh
# Then register a GitHub Actions self-hosted runner from
# Settings → Actions → Runners → New self-hosted runner.
set -eu

if [ "$(id -un)" != "ubuntu" ]; then
  echo "Run this as the ubuntu user on the EC2 instance."
  exit 1
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl rsync
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo mkdir -p /opt/zonematrix
sudo rsync -a --delete \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '_cache/' \
  ./ /opt/zonematrix/
if [ ! -f /opt/zonematrix/.env ]; then
  sudo cp /opt/zonematrix/.env.example /opt/zonematrix/.env
fi
sudo chown -R ubuntu:ubuntu /opt/zonematrix

sudo cp deploy/zonematrix.service /etc/systemd/system/zonematrix.service
sudo systemctl daemon-reload
sudo systemctl enable zonematrix
sudo systemctl restart zonematrix

echo
echo "App directory: /opt/zonematrix"
echo "Edit /opt/zonematrix/.env, then: sudo systemctl restart zonematrix"
echo "Next: install the GitHub Actions runner on this instance so a push to main deploys."
