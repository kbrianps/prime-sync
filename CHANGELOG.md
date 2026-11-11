# Changelog

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
