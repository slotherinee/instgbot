# Snapsave Media Downloader

Download Instagram, Facebook and TikTok media using snapsave.app downloader

## Install dependency
```bash
# Using npm
npm install snapsave-media-downloader

# Using pnpm
pnpm add snapsave-media-downloader
```

Example:
```js
import { snapsave } from "snapsave-media-downloader";

const download = await snapsave("https://www.instagram.com/p/C51YHfWJwHK/");

console.log(download);
```
Output example (Instagram):
```json
{
  "success": true,
  "data": {
    "media": [
      {
        "url": "https://d.rapidcdn.app/d?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
        "thumbnail": "https://d.rapidcdn.app/d?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
        "type": "video"
      }
    ]
  }
}
```

Output example (Facebook):
```json
{
  "success": true,
  "data": {
    "description": "...",
    "preview": "https://scontent-iad3-2.xx.fbcdn.net/v/t51.29350-10/466628901_1297725364716204_4835926798887889488_n.jpg?...",
    "media": [
      {
        "resolution": "720p (HD)",
        "url": "https://d.rapidcdn.app/d?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
        "type": "video"
      },
      {
        "resolution": "360p (SD)",
        "url": "https://d.rapidcdn.app/d?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
        "type": "video"
      },
      {
        "resolution": "1080p",
        "shouldRender": true,
        "url": "https://snapsave.app/render.php?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
        "type": "video"
      }
    ]
  }
}
```

Output example (TikTok):
```json
{
  "success": true,
  "data": {
    "description": "Does anyone else’s cat love doing this️ #RoadTo16Million #Pubity(Andrew Kuzmic via ViralHog)",
    "preview": "https://p16-useast2a.tiktokcdn.com/tos-useast2a-avt-0068-euttp/240d7e6a213e5cc0ef7dc69277408efc~tplv-tiktokx-cropcenter-q:720:720:q75.jpeg",
    "media": [
      {
        "url": "httpss://snapxcdn.com/v2/?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
        "type": "video"
      }
    ]
  }
}
```