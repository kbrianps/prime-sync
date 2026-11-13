# Changelog

## 1.6.0

- Sync goes on hold when people in the room are on different episodes, with a notice and a `⚠ Bia is on S1E4` chip. It resumes by itself once everyone opens the same episode.
- The chat shows who is in the room, with the episode each person is on and whether they still have signal.
- The Sync button turns sync on and joins the room when sync is off.
- The extension asks the room for the current position every time the connection to the server comes back.
- Texts refer to everyone in the room instead of a single partner, and "no signal" names whoever dropped, even with more than two people.
- Buy me a coffee link in the popup and the READMEs.
- Fixed: the chat input showed a scrollbar on a single line. It now grows only when needed.
- Fixed: a chat message without a name showed "Parceiro" even with the English interface.

## 1.5.0

- The MQTT server is now configured in the popup (address, optional username and password). No broker ships with the extension.
- The popup suggests the EMQX public broker as an opt-in, with its risk spelled out, and warns while it is in use.
- New popup and in-video chat design, plus a new infinity icon.
- English interface by default, with Brazilian Portuguese through an EN | PT switch in the popup; the overlay switches live.
- Chat groups consecutive messages and shows the time inside each bubble.
- "Leave room" asks for confirmation inline instead of a browser dialog.
- Room codes use `crypto.getRandomValues`.
- Fixed: connecting no longer hangs when the server refuses the login or closes before accepting.
- Fixed: the new-message toast showed "undefined" when the partner had no name.
- Offline unit tests for the MQTT client, a project checker and CI.
- README in English and LEIA-ME in Brazilian Portuguese, written for non-technical users; GPL-3.0 license.

## 1.4.1

- OK button to close the popup.

## 1.4.0

- Hide the interface with a handle on the screen edge to bring it back.
- Chip showing who paused.
- Keyboard input in the chat no longer reaches the player.

## 1.3.1

- First version: play, pause, seek and speed in sync between two browsers, room chat and connection indicator.
