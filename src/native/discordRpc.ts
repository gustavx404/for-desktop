import { Client } from "discord-rpc";

import { config } from "./config";
import { getStrings } from "./i18n";

// internal state
let rpc: Client;

export async function initDiscordRpc() {
  if (!config.discordRpc) return;

  // Release the previous client's transport (its underlying IPC
  // socket/pipe to the Discord desktop client) before replacing it --
  // removeAllListeners() alone only clears JS-side listeners, it never
  // closes that connection. Without this, every reconnect attempt
  // (retried every 10s for as long as Discord isn't running) would leak
  // a new open transport instead of releasing the previous one.
  if (rpc) {
    try {
      await rpc.destroy();
    } catch {
      // already closed, or never got far enough to connect -- nothing
      // to clean up
    }
    rpc.removeAllListeners();
  }

  try {
    rpc = new Client({ transport: "ipc" });

    rpc.on("ready", () => {
      const t = getStrings().discordRpc;

      rpc.setActivity({
        state: "stoat.chat",
        details: t.details,
        largeImageKey: "qr",
        largeImageText: t.largeImageText,
        buttons: [
          {
            label: t.joinButton,
            url: "https://stoat.chat/",
          },
        ],
      });
    });

    rpc.on("disconnected", reconnect);

    rpc.login({ clientId: "872068124005007420" }).catch(reconnect);
  } catch (err) {
    reconnect();
  }
}

const reconnect = () => setTimeout(() => initDiscordRpc(), 1e4);

export async function destroyDiscordRpc() {
  rpc?.destroy();
}
