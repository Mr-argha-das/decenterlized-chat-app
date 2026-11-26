import React from "react";

export function BrandLogo({ className = "w-9 h-9" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="RelayChat Logo"
    >
      <rect width="48" height="48" rx="13" fill="url(#rc_grad)" />
      <path
        d="M14 18.5C14 15.4624 16.4624 13 19.5 13H28.5C31.5376 13 34 15.4624 34 18.5V25.5C34 28.5376 31.5376 31 28.5 31H22.2L16.4 35.4C15.58 36.02 14.4 35.44 14.4 34.4V30.6C14.14 29.95 14 29.24 14 28.5V18.5Z"
        stroke="white"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="22" r="2" fill="white" />
      <circle cx="28" cy="22" r="2" fill="white" />
      <path d="M22 22H26" stroke="white" strokeWidth="2" strokeLinecap="round" />
      <defs>
        <linearGradient id="rc_grad" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00A884" />
          <stop offset="1" stopColor="#007A60" />
        </linearGradient>
      </defs>
    </svg>
  );
}
