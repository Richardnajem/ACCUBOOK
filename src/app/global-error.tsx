'use client';

import { useEffect } from 'react';
import { addErrorLog } from '@/lib/errorLogger';

/**
 * Next.js root error boundary. Catches render failures that escape the React
 * tree (and therefore `window.onerror`), records them in the shared error log
 * and offers a retry.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        addErrorLog('error', `global-error${error.digest ? ` (${error.digest})` : ''}`, error.message || 'Unknown render error', error.stack);
    }, [error]);

    return (
        <html lang="en">
            <body style={{ background: '#0b0f17', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif' }}>
                <div style={{ maxWidth: 560, margin: '15vh auto', padding: 24, textAlign: 'center' }}>
                    <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Something broke in Stockfolio</h1>
                    <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 16 }}>
                        The error was logged locally. You can retry, or reload the page.
                    </p>
                    <pre style={{ textAlign: 'left', fontSize: 12, background: '#111827', padding: 12, borderRadius: 8, overflowX: 'auto', color: '#f87171' }}>
                        {error.message}
                    </pre>
                    <button
                        onClick={reset}
                        style={{ marginTop: 16, padding: '8px 16px', borderRadius: 8, border: '1px solid #374151', background: '#1f2937', color: '#e5e7eb', cursor: 'pointer' }}
                    >
                        Try again
                    </button>
                </div>
            </body>
        </html>
    );
}
