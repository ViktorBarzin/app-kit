/** /ws: a WebSocket that sends every text frame back (Nitro's crossws on Bun). */
import { defineWebSocketHandler } from "nitro";

export default defineWebSocketHandler({
	message(peer, message) {
		peer.send(message.text());
	},
});
