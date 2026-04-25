#!/bin/bash
# Securely wipe the raw output folder
srm -rf ~/SwarmUI/Output/local/raw
srm -rf ~/illustrator/public/generations

# Re-create the directory so SwarmUI doesn't crash on the next run
mkdir -p ~/SwarmUI/Output/local/raw
mkdir -p ~/illustrator/public/generations

# Tell the SSD to physically clear deleted blocks
sudo fstrim -v /
