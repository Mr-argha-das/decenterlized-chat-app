"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  Download,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { UsernameCheckResponse, apiFetch } from "@/lib/api/client";
import { useAuthStore } from "@/store/useAuthStore";

export default function SignupPage() {
  const router = useRouter();
  const { signup, exportKeyBackup, user, keyFingerprint } = useAuthStore();
  const appName = process.env.NEXT_PUBLIC_APP_NAME || "RelayChat";
  const defaultDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || "chatapp.in";

  const [step, setStep] = useState<"form" | "backup">("form");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  // Live username availability state
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [availability, setAvailability] = useState<UsernameCheckResponse | null>(null);

  // Signup & keygen status
  const [submitting, setSubmitting] = useState(false);
  const [statusStep, setStatusStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Post-signup encrypted key backup state
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupDownloaded, setBackupDownloaded] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const normalized = username.trim().toLowerCase();
  const previewId = `${normalized || "username"}@${availability?.id.split("@")[1] || defaultDomain}`;

  useEffect(() => {
    if (!normalized) {
      setAvailability(null);
      setCheckingUsername(false);
      return;
    }

    let cancelled = false;
    setCheckingUsername(true);
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch<UsernameCheckResponse>(
          `/users/check-username/${encodeURIComponent(normalized)}`
        );
        if (!cancelled) {
          setAvailability(res);
        }
      } catch {
        if (!cancelled) {
          setAvailability(null);
        }
      } finally {
        if (!cancelled) {
          setCheckingUsername(false);
        }
      }
    }, 240);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [normalized]);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (availability && !availability.valid) {
      setError(availability.reason || "Invalid username format.");
      return;
    }
    if (availability && !availability.available) {
      setError(availability.reason || "That username is already taken.");
      return;
    }

    setSubmitting(true);
    try {
      setStatusStep("Generating ECDH P-256 keypair in browser Web Crypto...");
      await signup({
        username: normalized,
        password,
        displayName: displayName || undefined,
      });
      setBackupPassphrase(password);
      setStep("backup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed.");
    } finally {
      setSubmitting(false);
      setStatusStep(null);
    }
  };

  const handleDownloadBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBackupError(null);
    setExporting(true);
    try {
      const jsonStr = await exportKeyBackup(backupPassphrase);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${user?.global_id || normalized}.relaykey.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBackupDownloaded(true);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Failed to encrypt backup.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f0f2f5] dark:bg-[#111b21] text-slate-900 dark:text-slate-100">
      <div className="h-52 w-full bg-[#00a884] dark:bg-[#008069] shrink-0">
        <div className="max-w-4xl mx-auto px-6 pt-8 flex items-center justify-between">
          <div className="flex items-center gap-3 text-white">
            <BrandLogo className="w-10 h-10 shadow-md rounded-xl" />
            <div>
              <span className="font-semibold text-lg tracking-tight block leading-none">
                {appName.toUpperCase()} WEB
              </span>
              <span className="text-xs text-emerald-100/90 flex items-center gap-1 mt-1">
                <Globe className="w-3.5 h-3.5" /> Federated Node:{" "}
                <strong className="font-mono">{defaultDomain}</strong>
              </span>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs text-emerald-50 bg-black/15 px-3 py-1.5 rounded-full">
            <Lock className="w-3.5 h-3.5" />
            <span>ECDH P-256 + AES-256-GCM</span>
          </div>
        </div>
      </div>

      <main className="flex-1 px-4 pb-12 -mt-24">
        <div className="max-w-xl mx-auto rounded-2xl bg-white dark:bg-[#202c33] shadow-2xl border border-slate-200/80 dark:border-slate-800 p-7 sm:p-9">
          {step === "form" ? (
            <>
              <div className="mb-6">
                <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                  Create Your Federated Identity
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Your private encryption key is generated locally via Web Crypto and stored only in
                  IndexedDB.
                </p>
              </div>

              {/* Live Federated ID Preview Banner */}
              <div className="mb-5 rounded-xl bg-slate-50 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700/80 px-4 py-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">
                    Global Federated ID Preview
                  </div>
                  <div
                    data-testid="signup-id-preview"
                    className="text-sm font-mono font-semibold text-[#008069] dark:text-[#00a884] mt-0.5"
                  >
                    {previewId}
                  </div>
                </div>
                <KeyRound className="w-5 h-5 text-[#00a884] shrink-0" />
              </div>

              <form onSubmit={handleSignup} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Username (3–20 chars: a-z, 0-9, _ or .)
                  </label>
                  <div className="flex items-center rounded-xl bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 focus-within:border-[#00a884] overflow-hidden">
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="rahul"
                      required
                      autoComplete="username"
                      data-testid="signup-username-input"
                      className="flex-1 bg-transparent px-3.5 py-2.5 text-sm focus:outline-none"
                    />
                    <span className="px-3 py-2.5 text-xs font-mono text-slate-500 dark:text-slate-400 bg-slate-200/70 dark:bg-slate-800/70 border-l border-slate-200 dark:border-slate-700">
                      @{defaultDomain}
                    </span>
                  </div>

                  {/* Live availability feedback */}
                  <div className="mt-1.5 min-h-[18px] text-xs flex items-center gap-1.5">
                    {checkingUsername ? (
                      <span className="inline-flex items-center gap-1 text-slate-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking availability...
                      </span>
                    ) : availability ? (
                      availability.available ? (
                        <span
                          data-testid="username-available"
                          className="inline-flex items-center gap-1 text-emerald-600 dark:text-[#00a884] font-medium"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> {availability.id} is available
                        </span>
                      ) : (
                        <span
                          data-testid="username-unavailable"
                          className="inline-flex items-center gap-1 text-red-600 dark:text-red-400"
                        >
                          <XCircle className="w-3.5 h-3.5" /> {availability.reason}
                        </span>
                      )
                    ) : null}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Rahul Sharma"
                    maxLength={80}
                    data-testid="signup-displayname-input"
                    className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-[#00a884]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Account Password (min 8 chars, hashed with Argon2id)
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    minLength={8}
                    required
                    autoComplete="new-password"
                    data-testid="signup-password-input"
                    className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-[#00a884]"
                  />
                </div>

                {statusStep && (
                  <div className="flex items-center gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 px-3.5 py-2.5 text-xs text-emerald-800 dark:text-emerald-300">
                    <Sparkles className="w-4 h-4 animate-pulse text-[#00a884]" />
                    <span>{statusStep}</span>
                  </div>
                )}

                {error && (
                  <div className="rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={
                    submitting ||
                    checkingUsername ||
                    (availability !== null && (!availability.valid || !availability.available))
                  }
                  data-testid="signup-submit-button"
                  className="w-full py-2.5 px-4 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white font-semibold text-sm transition shadow-md shadow-[#00a884]/20"
                >
                  {submitting ? "Generating Keys & Signing Up..." : "Generate Keys & Sign Up"}
                </button>
              </form>

              <div className="mt-6 pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>Already have an identity?</span>
                <Link
                  href="/login"
                  className="font-semibold text-[#008069] dark:text-[#00a884] hover:underline"
                >
                  Sign in here →
                </Link>
              </div>
            </>
          ) : (
            /* Step 2: Post-signup Encrypted Key Backup Download */
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#00a884]/15 text-[#00a884]">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Identity Ready: <span className="font-mono text-[#00a884]">{user?.global_id}</span>
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    ECDH P-256 private key stored in IndexedDB • Never sent to server
                  </p>
                </div>
              </div>

              {keyFingerprint && (
                <div className="rounded-xl bg-slate-50 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 p-3.5 text-xs">
                  <div className="text-slate-500 dark:text-slate-400 mb-1">
                    Public Key Safety Fingerprint
                  </div>
                  <div className="font-mono text-slate-800 dark:text-slate-200">
                    {keyFingerprint}
                  </div>
                </div>
              )}

              <form onSubmit={handleDownloadBackup} className="space-y-3">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Save Password-Protected Key Backup (PBKDF2-SHA256 + AES-256-GCM)
                </label>
                <input
                  type="password"
                  value={backupPassphrase}
                  onChange={(e) => setBackupPassphrase(e.target.value)}
                  placeholder="Backup passphrase (min 8 characters)"
                  minLength={8}
                  required
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-[#00a884]"
                />
                {backupError && (
                  <div className="text-xs text-red-600 dark:text-red-400">{backupError}</div>
                )}
                <button
                  type="submit"
                  disabled={exporting}
                  className="w-full py-2.5 px-4 rounded-xl bg-slate-800 dark:bg-[#111b21] hover:bg-slate-700 border border-slate-700 text-white text-sm font-medium flex items-center justify-center gap-2 transition"
                >
                  <Download className="w-4 h-4 text-[#00a884]" />
                  {backupDownloaded
                    ? "Backup Downloaded (.relaykey.json) — Download Again"
                    : "Download Encrypted Key Backup (.relaykey.json)"}
                </button>
              </form>

              <button
                type="button"
                onClick={() => router.replace("/?auth=1")}
                data-testid="continue-to-app-button"
                className="w-full py-2.5 px-4 rounded-xl bg-[#00a884] hover:bg-[#008f6f] text-white font-semibold text-sm flex items-center justify-center gap-2 transition shadow-md shadow-[#00a884]/20"
              >
                <span>Open {appName} Web</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
