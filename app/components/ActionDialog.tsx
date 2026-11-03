"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Resolve / Reopen dialog. Resolve needs a comment; when recovery isn't verified
 * the warning comes first and the button says so ("Resolve anyway").
 */
export function ActionDialog({
  mode,
  status,
  onSubmit,
  onClose,
}: {
  mode: "resolve" | "reopen";
  status?: string;
  onSubmit: (comment: string, confirm: boolean) => Promise<string | null>; // returns an error message, or null on success
  onClose: () => void;
}) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const unverified = mode === "resolve" && status !== "mitigated";

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (mode === "resolve" && !comment.trim()) return setError("A resolution comment is required.");
    setBusy(true);
    const err = await onSubmit(comment.trim(), unverified);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/60" onClick={onClose} />
      <form
        className="relative w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-950 p-4 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="action-dialog-title" className="text-sm font-semibold text-zinc-100">
          {mode === "resolve" ? "Resolve incident" : "Reopen incident"}
        </h2>
        {unverified && (
          <p role="alert" className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            Recovery hasn&apos;t been verified (status: {status ?? "investigating"}). Resolving now closes the incident without a human report that service
            recovered after the fix.
          </p>
        )}
        <label htmlFor="action-comment" className="mt-3 block text-xs text-zinc-400">
          {mode === "resolve" ? "Resolution comment (required)" : "Why is it being reopened? (optional)"}
        </label>
        <textarea
          ref={input}
          id="action-comment"
          rows={3}
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={mode === "resolve" ? "e.g. Stable for 30 minutes after the revert; closing." : "e.g. Errors are back since 15:10."}
          className="mt-1 block w-full resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
        <p className="mt-1 text-[11px] text-zinc-500">Recorded as evidence; no agent run.</p>
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
              unverified ? "bg-amber-400 text-zinc-950 hover:bg-amber-300" : "bg-zinc-100 text-zinc-900 hover:bg-white"
            }`}
          >
            {mode === "reopen" ? "Reopen" : unverified ? "Resolve anyway" : "Resolve"}
          </button>
        </div>
      </form>
    </div>
  );
}
