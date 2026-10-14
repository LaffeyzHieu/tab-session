# Tab Time Limiter 🐢

A Chromium extension that tracks active tab time on distracting sites
and blocks you when you've had enough.

## Features
- Tracks active time on YouTube, TikTok, Facebook
- Only counts when tab is focused + window is active
- Blur overlay with countdown when session ends
- "More 1 min" button with penalty (session limit × 2)
- Persistent cooldown — survives browser restart
- Configurable session limit & cooldown via popup

## Install (Developer Mode)
1. Clone this repo
2. Go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select this folder

## Usage
- Set your session limit in the popup
- Browse normally — timer runs in background
- When time's up, overlay appears
- Hit **Alright** to start cooldown
- Hit **More 1 min** if you dare 🫠

## Structure
\`\`\`
├── manifest.json
├── background.js
├── content.js
├── content.css
├── popup.html
├── popup.js
└── img/
    ├── stg1.png
    ├── stg2.png
    └── 60min.png
\`\`\`
