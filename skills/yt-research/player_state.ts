/**
 * Fetches current player state from the browser extension via the server.
 */

import { BROWSERBUD_SERVER_URL } from "./config.js";

export interface PlayerState {
  videoId: string;
  title: string;
  channel: string;
  currentTime: number;
  currentTimeFormatted: string;
  duration: number;
  state: string;
  playbackRate: number;
}

export async function fetchPlayerState(videoId: string): Promise<PlayerState> {
  const response = await fetch(`${BROWSERBUD_SERVER_URL}/api/player-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Player state request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { ok: boolean; error?: string } & PlayerState;
  if (!data.ok) {
    throw new Error(data.error || "Player state request returned not-ok");
  }

  return {
    videoId: data.videoId,
    title: data.title,
    channel: data.channel,
    currentTime: data.currentTime,
    currentTimeFormatted: data.currentTimeFormatted,
    duration: data.duration,
    state: data.state,
    playbackRate: data.playbackRate,
  };
}
