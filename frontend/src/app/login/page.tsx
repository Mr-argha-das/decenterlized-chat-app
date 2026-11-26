"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Globe,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { useAuthStore } from "@/store/useAuthStore";

export default function LoginPage() {
  const router = useRouter();
  const {
    login,
    user,
    importKeyBackup,
    rotateNewDeviceKeyPair,
    logout,
  } = useAuthStore();

  const appName = process.env.NEXT_PUBLIC_APP_NAME || "RelayChat";
  const defaultDomain = process.env.NEXT_PUBLIC_APP_DOMAIN || "chatapp.in";

  const [step, setStep] = useState<"credentials" | "restore">("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore flow state for new devices
  const [backupJson, setBackupJson] = useState("");
  const [backupFileName, setBackupFileName] = useState<string | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login({ username, password });
      if (result.needsKeyRestore) {
        setStep("restore");
      } else {
        router.replace("/?auth=1");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid username or password.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRestoreKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backupJson) {
      setRestoreError("Please upload your .relaykey.json backup file.");
      return;
    }
    setRestoreError(null);
    setRestoring(true);
    try {
      await importKeyBackup(backupJson, backupPassphrase);
      router.replace("/?auth=1");
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Key backup decryption failed.");
    } finally {
      setRestoring(false);
    }
  };

  const handleGenerateFreshDeviceKey = async () => {
    setRestoreError(null);
    setRestoring(true);
    try {
      await rotateNewDeviceKeyPair();
      router.replace("/?auth=1");
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : "Failed to generate new keypair.");
    } finally {
      setRestoring(false);
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
            <span>Zero-Knowledge Keystore</span>
          </div>
        </div>
      </div>

      <main className="flex-1 px-4 pb-12 -mt-24">
        <div className="max-w-md mx-auto rounded-2xl bg-white dark:bg-[#202c33] shadow-2xl border border-slate-200/80 dark:border-slate-800 p-7 sm:p-9">
          {step === "credentials" ? (
            <>
              <div className="mb-6">
                <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
                  Sign In to {appName}
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Enter your username or full <code className="font-mono">username@{defaultDomain}</code>{" "}
                  ID.
                </p>
              </div>

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Username or Federated ID
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={`rahul or rahul@${defaultDomain}`}
                    required
                    autoComplete="username"
                    data-testid="login-username-input"
                    className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-[#00a884]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    autoComplete="current-password"
                    data-testid="login-password-input"
                    className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-[#00a884]"
                  />
                </div>

                {error && (
                  <div className="rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  data-testid="login-submit-button"
                  className="w-full py-2.5 px-4 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white font-semibold text-sm transition shadow-md shadow-[#00a884]/20"
                >
                  {submitting ? "Signing In..." : "Sign In"}
                </button>
              </form>

              <div className="mt-6 pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>New to {appName}?</span>
                <Link
                  href="/signup"
                  className="font-semibold text-[#008069] dark:text-[#00a884] hover:underline"
                >
                  Create an identity →
                </Link>
              </div>
            </>
          ) : (
            /* New-device E2EE Key Restore step right on /login */
            <form onSubmit={handleRestoreKey} className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#00a884]/15 text-[#00a884]">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    New Device Detected
                  </h2>
                  <p className="text-xs font-mono text-[#00a884]">{user?.global_id}</p>
                </div>
              </div>

              <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 p-3 text-xs text-amber-900 dark:text-amber-200">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <span>
                  Your private key is not in this browser&apos;s IndexedDB yet. Import your
                  password-protected <code className="font-mono">.relaykey.json</code> backup to
                  unlock E2EE messages on this device.
                </span>
              </div>

              <label className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 hover:border-[#00a884] cursor-pointer bg-slate-50 dark:bg-[#111b21] text-xs text-slate-700 dark:text-slate-300 transition">
                <Upload className="w-4 h-4 text-[#00a884]" />
                <span className="truncate">
                  {backupFileName || "Select .relaykey.json backup file"}
                </span>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setBackupFileName(f.name);
                    setBackupJson(await f.text());
                    setRestoreError(null);
                  }}
                  className="hidden"
                />
              </label>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Backup Passphrase
                </label>
                <input
                  type="password"
                  value={backupPassphrase}
                  onChange={(e) => setBackupPassphrase(e.target.value)}
                  placeholder="Enter backup passphrase"
                  required
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-100 dark:bg-[#111b21] border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-[#00a884]"
                />
              </div>

              {restoreError && (
                <div className="rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-3.5 py-2 text-xs text-red-700 dark:text-red-300">
                  {restoreError}
                </div>
              )}

              <button
                type="submit"
                disabled={restoring}
                className="w-full py-2.5 px-4 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white font-semibold text-sm transition"
              >
                {restoring ? "Decrypting Key..." : "Decrypt & Restore Key"}
              </button>

              <div className="pt-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={handleGenerateFreshDeviceKey}
                  disabled={restoring}
                  className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-[#00a884]"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Generate new keypair instead
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await logout();
                    setStep("credentials");
                  }}
                  className="text-red-600 dark:text-red-400 hover:underline"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
