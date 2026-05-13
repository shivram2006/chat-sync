# StudyFlow — Setup & Deployment Guide

## What This Is
A disguised study planner web app with a hidden encrypted real-time chat.
Only 2 users. No login. No database. Messages vanish on close.

---

## SECRET COMMANDS
| Type in "Add Task" box | Action |
|------------------------|--------|
| `2006`                 | Open hidden chat |
| `0000`                 | Emergency hide instantly |
| `1999`                 | Clear visible messages |
| `ESC` key              | Close chat (emergency) |

---

## LOCAL SETUP (Development)

### Step 1 — Clone / extract project
```bash
cd studyplanner
```

### Step 2 — Create virtual environment
```bash
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate
```

### Step 3 — Install dependencies
```bash
pip install -r requirements.txt
```

### Step 4 — Collect static files
```bash
python manage.py collectstatic --no-input
```

### Step 5 — Run with Daphne (supports WebSockets)
```bash
daphne -b 127.0.0.1 -p 8002 studyplanner.asgi:application
```

Open: http://127.0.0.1:8000

> ⚠️ Do NOT use `python manage.py runserver` — it does NOT support WebSockets.
> Always use Daphne.

---

## RENDER DEPLOYMENT (Free)

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2 — Create Render Web Service
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Configure:

| Field            | Value                                      |
|------------------|--------------------------------------------|
| Environment      | Python 3                                   |
| Build Command    | `./build.sh`                               |
| Start Command    | `daphne -b 0.0.0.0 -p $PORT studyplanner.asgi:application` |
| Instance Type    | Free                                       |

### Step 3 — Add Environment Variables on Render
| Key                | Value                          |
|--------------------|--------------------------------|
| `DJANGO_SECRET_KEY`| (any long random string)       |
| `DEBUG`            | `False`                        |
| `PYTHON_VERSION`   | `3.11.0`                       |

### Step 4 — Deploy
Click **Deploy** — Render builds and starts the app automatically.

Your app URL will be: `https://your-app-name.onrender.com`

---

## HOW THE CHAT WORKS

### For You (Admin/Developer)
1. Open the website
2. Type `2006` in the "Add Task" input
3. Chat panel opens from bottom-right
4. Type messages and press Enter

### For the Second User (Non-Technical)
1. Open the **same website URL**
2. Type `2006` in the task input box
3. Chat is immediately available — no login, no setup

### Auto-Hide
- Chat closes automatically after **60 seconds** of inactivity
- Timer resets each time a message is sent
- Returns to normal study planner view

---

## SECURITY MODEL

| Feature              | How it works                                      |
|----------------------|---------------------------------------------------|
| AES Encryption       | CryptoJS AES, shared key baked into JS            |
| Server blindness     | Django server only relays ciphertext, never decrypts |
| No storage           | InMemoryChannelLayer — messages never hit disk    |
| Ephemeral sessions   | Page refresh = all messages gone                  |
| Max 2 users          | WebSocket consumer enforces this with code 4001   |
| Stealth UI           | Looks 100% like a study planner to outsiders      |

---

## PROJECT STRUCTURE

```
studyplanner/
├── manage.py
├── requirements.txt
├── Procfile
├── build.sh
├── studyplanner/
│   ├── __init__.py
│   ├── settings.py       ← Django config
│   ├── urls.py           ← URL routing
│   └── asgi.py           ← ASGI + Channels entry point
├── chat/
│   ├── __init__.py
│   ├── consumers.py      ← WebSocket logic
│   ├── routing.py        ← WS URL routing
│   └── views.py          ← HTTP view
├── templates/
│   └── chat/
│       └── index.html    ← Main HTML (study planner + hidden chat)
└── static/
    ├── css/
    │   └── style.css     ← All styles
    └── js/
        └── app.js        ← All JS (planner + encryption + chat)
```

---

## NOTES

- **Change the encryption key** in `app.js` before deploying:
  Find `const _K = '...'` and set your own secret string.
  Both users must use the same deployed URL (same JS key).

- **Free Render tier** sleeps after inactivity. First load may take ~30s to wake up.

- **WebSocket on Render**: Render's free tier supports WebSockets natively with Daphne.

- **HTTPS**: Render provides HTTPS automatically. The JS auto-detects `wss://` vs `ws://`.
