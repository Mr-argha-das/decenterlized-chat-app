"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { MessageBubble } from "@/components/chat/MessageBubble";
import {
  ImageAttachmentMock,
  LocationAttachmentMock,
  MockMessage,
} from "@/mocks";

export interface MessageListProps {
  chatId: string;
  messages: MockMessage[];
  isGroupChat: boolean;
  isTyping: boolean;
  typingUser?: string;
  peerAvatarColor?: string;
  searchFilter?: string;
  hasMoreOlder?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlderMessages?: () => void;
  onReplyMessage: (msg: MockMessage) => void;
  onEditMessage?: (msg: MockMessage) => void;
  onDeleteMessage?: (messageId: string, scope: "me" | "everyone") => void;
  onPreviewImage: (img: ImageAttachmentMock) => void;
  onPreviewLocation: (loc: LocationAttachmentMock) => void;
}

type VirtualRow =
  | { kind: "date"; key: string; dateLabel: string }
  | { kind: "message"; key: string; message: MockMessage; showTail: boolean }
  | { kind: "typing"; key: string; label: string };

function estimateRowHeight(row: VirtualRow): number {
  if (row.kind === "date") return 40;
  if (row.kind === "typing") return 50;
  const m = row.message;
  if (m.type === "system") return 44;
  let base = 48;
  if (m.type === "image") base = 258;
  else if (m.type === "location") base = 212;
  else if (m.type === "file") base = 86;
  else if (m.type === "voice") base = 78;
  else if (m.text) {
    const lines = Math.ceil(m.text.length / 46);
    base = 34 + lines * 20;
  }
  if (m.replyTo) base += 48;
  if (row.showTail) base += 8;
  return base;
}

const OVERSCAN = 12;

export function MessageList({
  chatId,
  messages,
  isGroupChat,
  isTyping,
  typingUser,
  peerAvatarColor,
  searchFilter = "",
  hasMoreOlder = false,
  isLoadingOlder = false,
  onLoadOlderMessages,
  onReplyMessage,
  onEditMessage,
  onDeleteMessage,
  onPreviewImage,
  onPreviewLocation,
}: MessageListProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const prevChatIdRef = useRef<string | null>(null);
  const prevMsgCountRef = useRef<number>(0);
  const prependAnchorRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(
    null
  );

  // Filter messages if in-chat search is active
  const filteredMessages = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => {
      if (m.text && m.text.toLowerCase().includes(q)) return true;
      if (m.file?.fileName.toLowerCase().includes(q)) return true;
      if (m.image?.caption?.toLowerCase().includes(q)) return true;
      if (m.location?.label.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [messages, searchFilter]);

  // Flatten into virtualized rows with date separators & typing bubble
  const rows: VirtualRow[] = useMemo(() => {
    const result: VirtualRow[] = [];
    let lastDateKey = "";
    let lastSenderId = "";

    for (let i = 0; i < filteredMessages.length; i++) {
      const m = filteredMessages[i];
      if (m.dateKey !== lastDateKey) {
        result.push({
          kind: "date",
          key: `date-${chatId}-${m.dateKey}-${i}`,
          dateLabel: m.dateLabel,
        });
        lastDateKey = m.dateKey;
        lastSenderId = "";
      }

      const showTail = m.type !== "system" && m.senderId !== lastSenderId;
      result.push({
        kind: "message",
        key: m.id,
        message: m,
        showTail,
      });
      lastSenderId = m.type === "system" ? "" : m.senderId;
    }

    if (isTyping && !searchFilter.trim()) {
      result.push({
        kind: "typing",
        key: `typing-${chatId}`,
        label: typingUser ? `${typingUser} is typing` : "typing",
      });
    }

    return result;
  }, [chatId, filteredMessages, isTyping, typingUser, searchFilter]);

  // Prefix sum offsets for O(log N) virtual window lookup
  const { offsets, totalHeight } = useMemo(() => {
    // Reference measureTick so updated heights recompute offsets cleanly
    void measureTick;
    const off = new Array<number>(rows.length + 1);
    off[0] = 12; // top padding
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const h = measuredHeightsRef.current.get(row.key) ?? estimateRowHeight(row);
      off[i + 1] = off[i] + h;
    }
    return { offsets: off, totalHeight: off[rows.length] + 16 };
  }, [rows, measureTick]);

  // Binary search start & end indices
  const { startIndex, endIndex } = useMemo(() => {
    if (rows.length === 0) return { startIndex: 0, endIndex: -1 };
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] < scrollTop) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const first = Math.max(0, lo - OVERSCAN);
    const maxVisibleY = scrollTop + viewportHeight;
    let last = lo;
    while (last < rows.length && offsets[last] < maxVisibleY) {
      last++;
    }
    last = Math.min(rows.length - 1, last + OVERSCAN);
    return { startIndex: first, endIndex: last };
  }, [rows.length, offsets, scrollTop, viewportHeight]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Observe viewport size
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight || 640);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scroll to bottom when opening a chat or appending a new bottom message
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      prevMsgCountRef.current = rows.length;
      prependAnchorRef.current = null;
      el.scrollTop = totalHeight;
      setScrollTop(el.scrollTop);
      setIsNearBottom(true);
      return;
    }

    // Preserve scroll anchor when older messages are prepended at top
    if (prependAnchorRef.current && rows.length > prevMsgCountRef.current) {
      const { prevScrollHeight, prevScrollTop } = prependAnchorRef.current;
      prependAnchorRef.current = null;
      prevMsgCountRef.current = rows.length;
      const heightDelta = totalHeight - prevScrollHeight;
      if (heightDelta > 0) {
        el.scrollTop = prevScrollTop + heightDelta;
        setScrollTop(el.scrollTop);
      }
      return;
    }

    if (rows.length > prevMsgCountRef.current && isNearBottom) {
      prevMsgCountRef.current = rows.length;
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
      });
    } else {
      prevMsgCountRef.current = rows.length;
    }
  }, [chatId, rows.length, totalHeight, isNearBottom]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsNearBottom(distFromBottom < 140);

    // Infinite scroll upward when near top
    if (
      el.scrollTop < 110 &&
      hasMoreOlder &&
      !isLoadingOlder &&
      onLoadOlderMessages &&
      !searchFilter.trim()
    ) {
      prependAnchorRef.current = {
        prevScrollHeight: totalHeight,
        prevScrollTop: el.scrollTop,
      };
      onLoadOlderMessages();
    }
  };

  const measureRowRef = useCallback((key: string, node: HTMLDivElement | null) => {
    if (!node) return;
    const h = Math.ceil(node.getBoundingClientRect().height);
    if (h > 0 && measuredHeightsRef.current.get(key) !== h) {
      measuredHeightsRef.current.set(key, h);
      setMeasureTick((t) => t + 1);
    }
  }, []);

  const handleJumpToMessage = useCallback(
    (targetMessageId: string) => {
      const idx = rows.findIndex(
        (r) => r.kind === "message" && r.message.id === targetMessageId
      );
      if (idx === -1 || !scrollContainerRef.current) return;
      const targetTop = Math.max(0, offsets[idx] - viewportHeight / 3);
      scrollContainerRef.current.scrollTo({ top: targetTop, behavior: "smooth" });
      setHighlightedId(targetMessageId);
      window.setTimeout(() => setHighlightedId(null), 1800);
    },
    [rows, offsets, viewportHeight]
  );

  const visibleSlice =
    endIndex >= startIndex ? rows.slice(startIndex, endIndex + 1) : [];

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        data-testid="virtualized-message-list"
        className="w-full h-full overflow-y-auto rc-chat-wallpaper rc-scrollbar relative"
      >
        <div style={{ height: `${totalHeight}px`, position: "relative", width: "100%" }}>
          {isLoadingOlder && (
            <div className="sticky top-2 z-20 flex justify-center pointer-events-none">
              <span
                style={{
                  backgroundColor: "var(--rc-surface-elevated)",
                  color: "var(--rc-text-secondary)",
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs shadow"
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00a884]" />
                Decrypting older messages...
              </span>
            </div>
          )}
          {visibleSlice.map((row, localIdx) => {
            const rowIndex = startIndex + localIdx;
            const top = offsets[rowIndex];

            return (
              <div
                key={row.key}
                ref={(node) => measureRowRef(row.key, node)}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${top}px)`,
                }}
              >
                {row.kind === "date" && (
                  <div className="flex justify-center py-2 select-none">
                    <span
                      style={{
                        backgroundColor: "var(--rc-date-bg)",
                        color: "var(--rc-text-secondary)",
                      }}
                      className="px-3 py-1 rounded-lg text-[11.5px] font-medium shadow-sm uppercase tracking-wide"
                    >
                      {row.dateLabel}
                    </span>
                  </div>
                )}

                {row.kind === "message" && (
                  <MessageBubble
                    message={row.message}
                    isGroupChat={isGroupChat}
                    showTail={row.showTail}
                    highlighted={highlightedId === row.message.id}
                    peerAvatarColor={peerAvatarColor}
                    onReply={onReplyMessage}
                    onEdit={onEditMessage}
                    onDelete={onDeleteMessage}
                    onJumpToMessage={handleJumpToMessage}
                    onPreviewImage={onPreviewImage}
                    onPreviewLocation={onPreviewLocation}
                  />
                )}

                {row.kind === "typing" && (
                  <div className="flex justify-start px-4 sm:px-10 mt-2">
                    <div
                      style={{
                        backgroundColor: "var(--rc-bubble-in)",
                        color: "var(--rc-text-secondary)",
                      }}
                      className="relative rounded-lg rounded-tl-none px-3.5 py-2.5 shadow-sm flex items-center gap-2"
                    >
                      <svg
                        viewBox="0 0 8 13"
                        width="8"
                        height="13"
                        className="absolute -left-[7px] top-0 pointer-events-none"
                        style={{ color: "var(--rc-bubble-in)" }}
                      >
                        <path
                          fill="currentColor"
                          d="M2.812 1H8v11.193L1.533 3.568C.474 2.156 1.042 1 2.812 1z"
                        />
                      </svg>
                      <div className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-[#8696a0] rc-typing-dot-1" />
                        <span className="w-2 h-2 rounded-full bg-[#8696a0] rc-typing-dot-2" />
                        <span className="w-2 h-2 rounded-full bg-[#8696a0] rc-typing-dot-3" />
                      </div>
                      <span className="text-[11px]">{row.label}...</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Floating Scroll-to-Bottom Button */}
      {!isNearBottom && (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          style={{
            backgroundColor: "var(--rc-surface-elevated)",
            color: "var(--rc-text-secondary)",
            borderColor: "var(--rc-border)",
          }}
          className="absolute right-5 bottom-4 w-10 h-10 rounded-full border shadow-lg flex items-center justify-center hover:scale-105 transition z-20"
          aria-label="Scroll to latest messages"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
