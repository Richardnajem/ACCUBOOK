'use client';

import { useEffect } from 'react';
import { initErrorLogger } from '@/lib/errorLogger';

/**
 * Installs the global error logger on the client. Rendered once from the root
 * layout; renders nothing. See `src/lib/errorLogger.ts` for where entries go.
 */
export function ErrorLoggerInit() {
    useEffect(() => {
        initErrorLogger();
    }, []);
    return null;
}
