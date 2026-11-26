"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, RefreshCw, ShieldAlert, Upload } from "lucide-react";
import { useAuthStore } from "@/store/useAuthStore";

export function KeyRestoreModal() {
  const router = useRouter();
  const { user, needsKeyRestore, importKeyBackup, rotateNewDeviceKeyPair, logout } =
    useAuthStore();

  const [backupText, setBackupText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || !needsKeyRestore) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const txt = await f.text();
    setBackupText(txt);
    setError(null);
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backupText) {
      setError("Please select your .relaykey.json backup file first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await importKeyBackup(backupText, passphrase);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to decrypt key backup.");
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateFreshKey = async () => {
    setLoading(true);
    setError(null);
    try {
      await rotateNewDeviceKeyPair();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate identity key.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-[#202c33] border border-slate-200 dark:border-slate-700/70 shadow-2xl overflow-hidden">
        <div className="bg-[#008069] dark:bg-[#00a884]/20 px-6 py-4 flex items-center gap-3">
          <div className="p-2 rounded-xl bg-white/15 text-white dark:text-[#00a884]">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white dark:text-slate-100">
              Restore Your E2EE Private Key
            </h2>
            <p className="text-xs text-emerald-100 dark:text-slate-400">
              Signed in as <span className="font-mono">{user.global_id}</span> on a new browser
            </p>
          </div>
        </div>

        <form onSubmit={handleRestore} className="p-6 space-y-4">
          <div className="flex items-start gap-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 p-3 text-xs text-amber-900 dark:text-amber-200">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <span>
              RelayChat servers never store your private key. Import your password-protected{" "}
              <code className="font-mono">.relaykey.json</code> backup to read existing encrypted
              messages on this device.
            </span>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
              Encrypted Key Backup File (.relaykey.json)
            </label>
            <label className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 hover:border-[#00a884] cursor-pointer bg-slate-50 dark:bg-[#111b21] text-xs text-slate-700 dark:text-slate-300 transition">
              <Upload className="w-4 h-4 text-[#00a884]" />
              <span className="truncate">
                {fileName ? fileName : "Choose .relaykey.json file..."}
              </span>
              <input
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
              Backup Passphrase
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter passphrase used when exporting backup"
              required
              className="w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-100 dark:bg-[#111b21] text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-[#00a884]"
            />
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl bg-[#00a884] hover:bg-[#008f6f] disabled:opacity-50 text-white font-medium text-sm transition shadow-sm"
          >
            {loading ? "Decrypting in Browser..." : "Unlock & Import Private Key"}
          </button>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-700/70 flex items-center justify-between gap-2 text-xs">
            <button
              type="button"
              onClick={handleGenerateFreshKey}
              disabled={loading}
              className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-400 hover:text-[#00a884] transition"
              title="Generates a brand-new P-256 keypair in this browser and updates your public key on the node"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Lost backup? Generate new keypair
            </button>
            <button
              type="button"
              onClick={async () => {
                await logout();
                router.replace("/login");
              }}
              className="text-red-600 dark:text-red-400 hover:underline"
            >
              Sign out
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
