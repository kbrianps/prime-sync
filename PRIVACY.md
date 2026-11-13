# Prime Sync privacy policy

Last updated: November 12, 2026

Prime Sync is a browser extension that keeps Prime Video playback in sync
between people in the same room and adds a room chat. It is an independent
project with no connection to Amazon.

## What the extension handles

| Data | Why | Where it goes |
| --- | --- | --- |
| Video position, play/pause state, playback speed | To keep everyone's player in step | The MQTT server you configured |
| Title and episode number on screen | To warn when people are watching different episodes | The MQTT server you configured |
| The name you type in "Your name in the chat" | To show who paused, who is in the room and who wrote each message | The MQTT server you configured |
| Chat messages | To deliver them to the room | The MQTT server you configured |
| Room code, server address, server username and password, interface preferences | To connect to your room | Stored only in your browser (`chrome.storage.local`) |

## What the extension does not do

- It does not read or send your Amazon account data, email, password or
  payment details.
- It does not record your browsing history. It only runs on Prime Video pages.
- It has no analytics, ads or tracking, and it does not sell or share data.
- It does not talk to any server other than the MQTT server you configure.
  The developer runs no server and receives no data.

## The MQTT server

You choose the server. Whoever runs it can see the data listed above for
your room. On a public server without a password (such as `broker.emqx.io`),
anyone connected can read the room and the chat. The popup warns you while
one is in use.

## Retention

The extension keeps no chat history: messages disappear when the tab is
closed. Your settings stay in your browser until you remove the extension or
clear its data. Retention on the MQTT server depends on whoever runs it.

## External links

The "Buy me a coffee" link opens buymeacoffee.com in a new tab only when you
click it. The extension loads nothing from that site.

## Contact

Open an issue at https://github.com/kbrianps/prime-sync/issues.
