import { INITIAL_MOCK_CHATS } from "./chats";
import { DeliveryStatus, MockChat, MockMessage } from "./types";

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;
}

export const MOCK_IMAGES = {
  jaipurSunset: svgToDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1e1b4b"/>
          <stop offset="52%" stop-color="#be185d"/>
          <stop offset="100%" stop-color="#fb923c"/>
        </linearGradient>
      </defs>
      <rect width="640" height="400" fill="url(#sky)"/>
      <circle cx="470" cy="135" r="54" fill="#fde047" opacity="0.88"/>
      <path d="M0 290 L110 245 L210 272 L320 225 L430 265 L545 235 L640 268 L640 400 L0 400 Z" fill="#4c1d95" opacity="0.55"/>
      <rect x="130" y="210" width="380" height="190" rx="8" fill="#881337"/>
      <g fill="#fda4af" opacity="0.85">
        <rect x="165" y="235" width="36" height="52" rx="18"/>
        <rect x="225" y="235" width="36" height="52" rx="18"/>
        <rect x="285" y="235" width="36" height="52" rx="18"/>
        <rect x="345" y="235" width="36" height="52" rx="18"/>
        <rect x="405" y="235" width="36" height="52" rx="18"/>
        <rect x="195" y="310" width="36" height="52" rx="18"/>
        <rect x="255" y="310" width="36" height="52" rx="18"/>
        <rect x="315" y="310" width="36" height="52" rx="18"/>
        <rect x="375" y="310" width="36" height="52" rx="18"/>
      </g>
      <text x="28" y="42" fill="#ffffff" font-family="sans-serif" font-size="16" font-weight="bold" opacity="0.9">Evening over Pink City • E2EE Photo</text>
    </svg>
  `),
  topologyDiagram: svgToDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="380" viewBox="0 0 640 380">
      <rect width="640" height="380" fill="#0f172a"/>
      <g stroke="#00a884" stroke-width="2.5" stroke-dasharray="6 4">
        <line x1="170" y1="190" x2="470" y2="120"/>
        <line x1="170" y1="190" x2="470" y2="265"/>
        <line x1="470" y1="120" x2="470" y2="265"/>
      </g>
      <rect x="70" y="145" width="190" height="90" rx="16" fill="#1e293b" stroke="#00a884" stroke-width="2"/>
      <text x="165" y="183" text-anchor="middle" fill="#f8fafc" font-family="monospace" font-size="15" font-weight="bold">chatapp.in</text>
      <text x="165" y="208" text-anchor="middle" fill="#34d399" font-family="sans-serif" font-size="12">Ed25519 Signed S2S</text>

      <rect x="380" y="75" width="190" height="86" rx="16" fill="#1e293b" stroke="#38bdf8" stroke-width="2"/>
      <text x="475" y="113" text-anchor="middle" fill="#f8fafc" font-family="monospace" font-size="15" font-weight="bold">blr.relay.net</text>
      <text x="475" y="138" text-anchor="middle" fill="#38bdf8" font-family="sans-serif" font-size="12">ECDH P-256 Ciphertext</text>

      <rect x="380" y="222" width="190" height="86" rx="16" fill="#1e293b" stroke="#a855f7" stroke-width="2"/>
      <text x="475" y="260" text-anchor="middle" fill="#f8fafc" font-family="monospace" font-size="15" font-weight="bold">sec.cipher.org</text>
      <text x="475" y="285" text-anchor="middle" fill="#c084fc" font-family="sans-serif" font-size="12">Zero-Knowledge Store</text>
    </svg>
  `),
  designTokens: svgToDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="320" height="360" fill="#efeae2"/>
      <rect x="320" width="320" height="360" fill="#0b141a"/>
      <rect x="36" y="60" width="230" height="64" rx="12" fill="#d9fdd3"/>
      <text x="54" y="97" fill="#111b21" font-family="sans-serif" font-size="14" font-weight="600">Light Outgoing #d9fdd3</text>
      <rect x="36" y="150" width="230" height="64" rx="12" fill="#ffffff"/>
      <text x="54" y="187" fill="#111b21" font-family="sans-serif" font-size="14" font-weight="600">Light Incoming #ffffff</text>

      <rect x="356" y="60" width="244" height="64" rx="12" fill="#005c4b"/>
      <text x="374" y="97" fill="#e9edef" font-family="sans-serif" font-size="14" font-weight="600">Dark Outgoing #005c4b</text>
      <rect x="356" y="150" width="244" height="64" rx="12" fill="#202c33"/>
      <text x="374" y="187" fill="#e9edef" font-family="sans-serif" font-size="14" font-weight="600">Dark Incoming #202c33</text>
      <text x="320" y="315" text-anchor="middle" fill="#00a884" font-family="monospace" font-size="14" font-weight="bold">RelayChat Dual-Theme Palette</text>
    </svg>
  `),
};

function makeWaveform(seed: number, bars = 36): number[] {
  const out: number[] = [];
  let x = seed + 11;
  for (let i = 0; i < bars; i++) {
    x = (x * 1664525 + 1013904223) % 4294967296;
    const normalized = 0.18 + ((x % 100) / 100) * 0.82;
    out.push(Number(normalized.toFixed(2)));
  }
  return out;
}

const ARCHIVE_SNIPPETS_PEER = [
  "Did you check how fast Web Crypto derives the P-256 shared key?",
  "Sub-millisecond in Chrome and Firefox! Zero server involvement.",
  "Let's make sure every federated envelope carries an Ed25519 signature header.",
  "Agreed — `X-Federation-Signature` + timestamp replay window of 5 minutes.",
  "Also tested chunked AES-GCM encryption on a 25 MB video — smooth!",
  "How is the IndexedDB keystore handling multiple local accounts?",
  "Keyed by `globalId` (`username@domain`), so switching accounts never collides.",
  "Nice! Let's also keep the message list virtualized so 1,000+ bubbles scroll at 60fps.",
  "Testing variable-height ResizeObserver measurements right now.",
  "Even mixed image, voice, location, and reply bubbles keep zero layout jump!",
];

const ARCHIVE_SNIPPETS_ME = [
  "Just pushed the Alembic migration for all MySQL 8 tables and indexes.",
  "Awesome — verified foreign key cascades on `devices` and `refresh_tokens` too.",
  "Password-protected `.relaykey.json` export uses 250,000 PBKDF2-SHA256 iterations.",
  "Perfect, and the new-device login screen prompts to restore it automatically.",
  "Let's test dark mode and light mode CSS variables side by side.",
  "Both `#d9fdd3` light green and `#005c4b` dark emerald bubbles have crisp tails.",
  "Read receipts turn `#53bdeb` blue as soon as the chat viewport opens.",
  "Keyboard shortcuts: `Enter` sends, `Shift+Enter` adds a newline, `Esc` closes chat!",
  "On mobile viewports `< 768px`, list and chat pane switch screens with a Back button.",
  "Let's meet in C-Scheme this evening to celebrate Phase 2!",
];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function buildPriya1050Messages(): MockMessage[] {
  const chatId = "chat-01";
  const peerId = "priya@chatapp.in";
  const peerName = "Priya Verma";
  const list: MockMessage[] = [];

  // System E2EE notice at the very start of the conversation
  list.push({
    id: `${chatId}-sys-0`,
    chatId,
    senderId: "system",
    senderName: "System",
    type: "system",
    text: "Messages and calls are end-to-end encrypted. No one outside of this chat, not even chatapp.in, can read or listen to them.",
    timestamp: "2026-11-10T09:00:00.000Z",
    timeLabel: "09:00",
    dateKey: "2026-11-10",
    dateLabel: "NOV 10, 2026",
  });

  const historicalDays = [
    { key: "2026-11-10", label: "NOV 10, 2026" },
    { key: "2026-11-14", label: "NOV 14, 2026" },
    { key: "2026-11-18", label: "NOV 18, 2026" },
    { key: "2026-11-21", label: "NOV 21, 2026" },
    { key: "2026-11-24", label: "NOV 24, 2026" },
    { key: "2026-11-25", label: "YESTERDAY" },
  ];

  // Generate 1,032 historical messages across 6 dates (172 per day) for real 1,000+ virtualization testing
  let seq = 1;
  for (let dIdx = 0; dIdx < historicalDays.length; dIdx++) {
    const day = historicalDays[dIdx];
    for (let i = 0; i < 172; i++) {
      const outgoing = (seq + dIdx) % 2 === 0;
      const totalMinutes = 9 * 60 + Math.floor((i / 172) * 660);
      const hh = pad2(Math.floor(totalMinutes / 60));
      const mm = pad2(totalMinutes % 60);
      const id = `${chatId}-hist-${seq}`;

      const msg: MockMessage = {
        id,
        chatId,
        senderId: outgoing ? "me" : peerId,
        senderName: outgoing ? "You" : peerName,
        type: "text",
        text: outgoing
          ? `[#${seq}] ${ARCHIVE_SNIPPETS_ME[seq % ARCHIVE_SNIPPETS_ME.length]}`
          : `[#${seq}] ${ARCHIVE_SNIPPETS_PEER[seq % ARCHIVE_SNIPPETS_PEER.length]}`,
        timestamp: `${day.key}T${hh}:${mm}:00.000Z`,
        timeLabel: `${hh}:${mm}`,
        dateKey: day.key,
        dateLabel: day.label,
        status: outgoing ? "read" : undefined,
      };

      // Sprinkle periodic voice, file, location, and reply bubbles throughout the 1,000+ scrollback too!
      if (seq % 45 === 0) {
        msg.type = "voice";
        msg.text = undefined;
        msg.voice = {
          durationSeconds: 14 + (seq % 35),
          waveform: makeWaveform(seq),
        };
      } else if (seq % 68 === 0) {
        msg.type = "file";
        msg.text = undefined;
        msg.file = {
          fileName: `benchmark-run-${seq}.json`,
          fileSize: "184 KB",
          extension: "JSON",
        };
      } else if (seq % 19 === 0 && list.length > 2) {
        const target = list[list.length - 2];
        if (target.type === "text" && target.text) {
          msg.replyTo = {
            messageId: target.id,
            senderName: target.senderId === "me" ? "You" : peerName,
            previewText: target.text,
            type: "text",
          };
        }
      }

      list.push(msg);
      seq++;
    }
  }

  // Recent TODAY showcase messages at the bottom so EVERY variant is immediately visible!
  const todayKey = "2026-11-26";
  const todayLabel = "TODAY";

  const showcase: MockMessage[] = [
    {
      id: `${chatId}-today-1`,
      chatId,
      senderId: "system",
      senderName: "System",
      type: "system",
      text: "Priya Verma verified your ECDH P-256 safety number",
      timestamp: "2026-11-26T14:10:00.000Z",
      timeLabel: "14:10",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-2`,
      chatId,
      senderId: peerId,
      senderName: peerName,
      type: "text",
      text: "Hey Argha! Ready to review all the bubble types for RelayChat Web?",
      timestamp: "2026-11-26T14:12:00.000Z",
      timeLabel: "14:12",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-3`,
      chatId,
      senderId: peerId,
      senderName: peerName,
      type: "image",
      image: {
        dataUrl: MOCK_IMAGES.jaipurSunset,
        caption: "Captured from Nahargarh viewpoint — encrypted client-side before upload!",
        width: 640,
        height: 400,
        fileName: "pink-city-evening.jpg",
      },
      timestamp: "2026-11-26T14:14:00.000Z",
      timeLabel: "14:14",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-4`,
      chatId,
      senderId: "me",
      senderName: "You",
      type: "text",
      text: "Whoa, that view looks incredible! And notice you can scroll up through 1,050+ virtualized messages smoothly.",
      replyTo: {
        messageId: `${chatId}-today-3`,
        senderName: peerName,
        previewText: "📷 Captured from Nahargarh viewpoint — encrypted client-side before upload!",
        type: "image",
      },
      status: "read",
      timestamp: "2026-11-26T14:16:00.000Z",
      timeLabel: "14:16",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-5`,
      chatId,
      senderId: "me",
      senderName: "You",
      type: "file",
      file: {
        fileName: "RelayChat-Federation-Spec-v2.pdf",
        fileSize: "2.4 MB",
        extension: "PDF",
        pageCount: 18,
      },
      status: "read",
      timestamp: "2026-11-26T14:21:00.000Z",
      timeLabel: "14:21",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-6`,
      chatId,
      senderId: peerId,
      senderName: peerName,
      type: "voice",
      voice: {
        durationSeconds: 28,
        waveform: makeWaveform(777, 36),
      },
      timestamp: "2026-11-26T14:29:00.000Z",
      timeLabel: "14:29",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-7`,
      chatId,
      senderId: "me",
      senderName: "You",
      type: "voice",
      voice: {
        durationSeconds: 16,
        waveform: makeWaveform(999, 36),
      },
      status: "delivered",
      timestamp: "2026-11-26T14:35:00.000Z",
      timeLabel: "14:35",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-8`,
      chatId,
      senderId: "me",
      senderName: "You",
      type: "text",
      text: "Check the three tick states too: blue read above, double-grey delivered on the voice note, and single-grey sent right below 👇",
      edited: true,
      status: "sent",
      timestamp: "2026-11-26T14:44:00.000Z",
      timeLabel: "14:44",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
    {
      id: `${chatId}-today-9`,
      chatId,
      senderId: peerId,
      senderName: peerName,
      type: "location",
      location: {
        label: "Hawa Mahal, Jaipur",
        address: "Hawa Mahal Rd, Badi Choupad, J.D.A. Market, Jaipur, Rajasthan 302002",
        latitude: 26.9239,
        longitude: 75.8267,
        isLive: true,
        liveExpiresLabel: "Live until 15:48",
      },
      timestamp: "2026-11-26T14:48:00.000Z",
      timeLabel: "14:48",
      dateKey: todayKey,
      dateLabel: todayLabel,
    },
  ];

  return [...list, ...showcase];
}

const GROUP_MEMBER_PALETTE = [
  "#f97316",
  "#ec4899",
  "#38bdf8",
  "#a855f7",
  "#22c55e",
  "#eab308",
];

function buildMessagesForChat(chat: MockChat, chatIndex: number): MockMessage[] {
  const msgs: MockMessage[] = [
    {
      id: `${chat.id}-sys`,
      chatId: chat.id,
      senderId: "system",
      senderName: "System",
      type: "system",
      text: chat.isGroup
        ? `Sender-key group encryption active for "${chat.name}" (${chat.memberCount} members)`
        : `Messages with ${chat.globalId} are end-to-end encrypted with ECDH P-256 + AES-256-GCM.`,
      timestamp: "2026-11-25T10:00:00.000Z",
      timeLabel: "10:00",
      dateKey: "2026-11-25",
      dateLabel: "YESTERDAY",
    },
  ];

  const count = 15;
  for (let i = 0; i < count; i++) {
    const isToday = i >= 7;
    const dateKey = isToday ? "2026-11-26" : "2026-11-25";
    const dateLabel = isToday ? "TODAY" : "YESTERDAY";
    const isLast = i === count - 1;

    const outgoing = isLast ? chat.lastMessageOutgoing : (i + chatIndex) % 3 === 1;
    const memberPool = (chat.memberNames || [chat.name]).filter((n) => n !== "You");
    const chosenMember = chat.isGroup
      ? memberPool[(i + chatIndex) % memberPool.length]
      : chat.name;
    const senderColor = chat.isGroup
      ? GROUP_MEMBER_PALETTE[(i + chatIndex) % GROUP_MEMBER_PALETTE.length]
      : undefined;

    const hh = pad2(10 + Math.floor(i / 3));
    const mm = pad2((i * 7 + chatIndex * 3) % 60);
    const statusCycle: DeliveryStatus[] = ["read", "delivered", "sent"];
    const status: DeliveryStatus | undefined = outgoing
      ? isLast && chat.lastMessageStatus
        ? chat.lastMessageStatus
        : statusCycle[i % statusCycle.length]
      : undefined;

    if (isLast) {
      if (chat.lastMessageType === "voice") {
        msgs.push({
          id: `${chat.id}-m-${i}`,
          chatId: chat.id,
          senderId: outgoing ? "me" : `${chosenMember.toLowerCase()}@${chat.globalId.split("@")[1]}`,
          senderName: outgoing ? "You" : chosenMember,
          senderColor,
          type: "voice",
          voice: {
            durationSeconds: chat.id === "chat-06" ? 34 : 19,
            waveform: makeWaveform(chatIndex * 100 + i),
          },
          timestamp: `${dateKey}T${hh}:${mm}:00.000Z`,
          timeLabel: chat.lastMessageTime.includes(":") ? chat.lastMessageTime : `${hh}:${mm}`,
          dateKey,
          dateLabel,
          status,
        });
        continue;
      }
      if (chat.lastMessageType === "file") {
        msgs.push({
          id: `${chat.id}-m-${i}`,
          chatId: chat.id,
          senderId: outgoing ? "me" : `${chosenMember.toLowerCase()}@${chat.globalId.split("@")[1]}`,
          senderName: outgoing ? "You" : chosenMember,
          senderColor,
          type: "file",
          file: {
            fileName:
              chat.id === "chat-03"
                ? "sender-key-rotation-benchmark.pdf"
                : chat.id === "chat-11"
                  ? "Threat-Model-Checklist.pdf"
                  : "mysql8-query-plan.sql",
            fileSize: "1.8 MB",
            extension: chat.id === "chat-17" ? "SQL" : "PDF",
            pageCount: chat.id === "chat-17" ? undefined : 12,
          },
          timestamp: `${dateKey}T${hh}:${mm}:00.000Z`,
          timeLabel: chat.lastMessageTime.includes(":") ? chat.lastMessageTime : `${hh}:${mm}`,
          dateKey,
          dateLabel,
          status,
        });
        continue;
      }
      if (chat.lastMessageType === "image") {
        msgs.push({
          id: `${chat.id}-m-${i}`,
          chatId: chat.id,
          senderId: outgoing ? "me" : `${chosenMember.toLowerCase()}@${chat.globalId.split("@")[1]}`,
          senderName: outgoing ? "You" : chosenMember,
          senderColor,
          type: "image",
          image: {
            dataUrl:
              chat.id === "chat-07" ? MOCK_IMAGES.designTokens : MOCK_IMAGES.topologyDiagram,
            caption: chat.lastMessagePreview.replace(/^[^:]+:\s*/, ""),
            width: 640,
            height: 360,
            fileName: "preview.png",
          },
          timestamp: `${dateKey}T${hh}:${mm}:00.000Z`,
          timeLabel: chat.lastMessageTime.includes(":") ? chat.lastMessageTime : `${hh}:${mm}`,
          dateKey,
          dateLabel,
          status,
        });
        continue;
      }
      if (chat.lastMessageType === "location") {
        msgs.push({
          id: `${chat.id}-m-${i}`,
          chatId: chat.id,
          senderId: outgoing ? "me" : `${chosenMember.toLowerCase()}@${chat.globalId.split("@")[1]}`,
          senderName: outgoing ? "You" : chosenMember,
          senderColor,
          type: "location",
          location: {
            label:
              chat.id === "chat-05"
                ? "Curious Life Coffee Roasters, C-Scheme"
                : "Sector 17 Plaza, Chandigarh",
            address:
              chat.id === "chat-05"
                ? "P-25, Yudhisthir Marg, C Scheme, Ashok Nagar, Jaipur"
                : "Sector 17, Chandigarh 160017",
            latitude: chat.id === "chat-05" ? 26.9048 : 30.7415,
            longitude: chat.id === "chat-05" ? 75.7973 : 76.7821,
          },
          timestamp: `${dateKey}T${hh}:${mm}:00.000Z`,
          timeLabel: chat.lastMessageTime.includes(":") ? chat.lastMessageTime : `${hh}:${mm}`,
          dateKey,
          dateLabel,
          status,
        });
        continue;
      }
    }

    // Mix rich non-text items inside every chat so every conversation feels alive
    if (i === 4) {
      msgs.push({
        id: `${chat.id}-m-${i}`,
        chatId: chat.id,
        senderId: outgoing ? "me" : `${chosenMember.toLowerCase()}@node`,
        senderName: outgoing ? "You" : chosenMember,
        senderColor,
        type: "image",
        image: {
          dataUrl: chatIndex % 2 === 0 ? MOCK_IMAGES.topologyDiagram : MOCK_IMAGES.designTokens,
          caption: "Updated federated node diagram & dual-theme tokens",
          width: 640,
          height: 380,
          fileName: "federation-diagram.svg",
        },
        timestamp: `${dateKey}T${hh}:${mm}:00.000Z`,
        timeLabel: `${hh}:${mm}`,
        dateKey,
        dateLabel,
        status,
      });
      continue;
    }

    if (i === 9) {
      msgs.push({
        id: `${chat.id}-m-${i}`,
        chatId: chat.id,
        senderId: outgoing ? "me" : `${chosenMember.toLowerCase()}@node`,
        senderName: outgoing ? "You" : chosenMember,
        senderColor,
        type: "voice",
        voice: {
          durationSeconds: 22,
          waveform: makeWaveform(chatIndex * 50 + i),
        },
        timestamp: `${dateKey}T${hh}:${mm}:00.000Z`,
        timeLabel: `${hh}:${mm}`,
        dateKey,
        dateLabel,
        status,
      });
      continue;
    }

    const textContent = isLast
      ? chat.lastMessagePreview.replace(/^[^:]+:\s*/, "")
      : outgoing
        ? ARCHIVE_SNIPPETS_ME[(i + chatIndex) % ARCHIVE_SNIPPETS_ME.length]
        : ARCHIVE_SNIPPETS_PEER[(i + chatIndex) % ARCHIVE_SNIPPETS_PEER.length];

    const prevMsg = i === 11 ? msgs[msgs.length - 1] : undefined;

    msgs.push({
      id: `${chat.id}-m-${i}`,
      chatId: chat.id,
      senderId: outgoing ? "me" : `${chosenMember.toLowerCase()}@node`,
      senderName: outgoing ? "You" : chosenMember,
      senderColor,
      type: "text",
      text: textContent,
      replyTo:
        prevMsg && prevMsg.type === "text" && prevMsg.text
          ? {
              messageId: prevMsg.id,
              senderName: prevMsg.senderName,
              previewText: prevMsg.text,
              type: "text",
            }
          : undefined,
      timestamp: `${dateKey}T${hh}:${mm}:00.000Z`,
      timeLabel: isLast && chat.lastMessageTime.includes(":") ? chat.lastMessageTime : `${hh}:${mm}`,
      dateKey,
      dateLabel,
      status,
    });
  }

  return msgs;
}

export function buildInitialMessagesByChat(): Record<string, MockMessage[]> {
  const map: Record<string, MockMessage[]> = {};
  INITIAL_MOCK_CHATS.forEach((chat, index) => {
    if (chat.id === "chat-01") {
      map[chat.id] = buildPriya1050Messages();
    } else {
      map[chat.id] = buildMessagesForChat(chat, index);
    }
  });
  return map;
}
