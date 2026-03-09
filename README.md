# Insta Follow - Chrome Extension

A Chrome extension that auto-follows Instagram users from a JSON file. Upload any JSON containing Instagram usernames and the extension will visit each profile and click the Follow button automatically.

## Features

- **JSON file upload** - Supports any JSON structure. The extension recursively searches for keys named `Instagram` (case-insensitive) and extracts usernames.
- **Language-independent** - Works regardless of your Instagram language settings. Uses CSS-based detection instead of button text matching.
- **Random delays** - Configurable random wait between follows to avoid rate limiting (default: 3-6 seconds).
- **Background processing** - Runs in a service worker so it keeps working even if you close the popup.
- **Resume support** - If you stop mid-way or close the browser, you can resume exactly where you left off.
- **Progress tracking** - Live progress bar, status updates, and a detailed log of every action.
- **Copy Log** - One-click copy of the full activity log.
- **Copy Failed** - One-click copy of all usernames that failed (profile not found, errors, etc.) so you can share them easily.

## JSON Format

The extension looks for any key named `Instagram` in your JSON. It works with any structure:

```json
[
  {"PeopleID": 1, "Name": "John Doe", "Instagram": "johndoe"},
  {"PeopleID": 2, "Name": "Jane Smith", "Instagram": "janesmith"},
  {"PeopleID": 3, "Name": "Bob", "Instagram": "https://instagram.com/bob123"}
]
```

It also handles:
- Full URLs (`https://www.instagram.com/username`)
- `@username` format
- Nested JSON objects
- Mixed structures

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the `insta-follow` folder

## Usage

1. Make sure you are **logged into Instagram** in Chrome
2. Click the extension icon in the toolbar
3. Upload your JSON file
4. Adjust the delay range if needed (default 3-6 seconds)
5. Click **Start Following**
6. The extension will open each profile in the active tab and click Follow

### Controls

- **Start Following** - Begin from the first user
- **Stop** - Pause at any time
- **Resume** - Continue from where you stopped
- **Copy Log** - Copy the full log to clipboard
- **Copy Failed** - Copy only the failed/not-found usernames
- **Clear History** - Reset all saved progress and logs

## Tips

- Keep the Instagram tab active while the extension is running
- If Instagram shows rate limit warnings, increase the delay range
- The extension saves progress automatically - you can close and reopen the popup anytime
- Use "Copy Failed" to get a list of usernames that need manual checking

## License

MIT
