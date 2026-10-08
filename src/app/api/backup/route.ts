import { NextRequest, NextResponse } from "next/server";
import { SCHEMA_VERSION } from "@/lib/db";
import { backupDir, createBackup, listBackups, restoreBackup } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/backup — what exists right now, and where it lives.
export async function GET() {
  return NextResponse.json({
    backups: listBackups(),
    directory: backupDir(),
    schemaVersion: SCHEMA_VERSION,
  });
}

// POST /api/backup — { action: "create", label? } | { action: "restore", name }
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    label?: string;
    name?: string;
  } | null;

  if (body?.action === "create") {
    try {
      return NextResponse.json({ backup: createBackup(body.label ?? "manual") });
    } catch (err) {
      return NextResponse.json(
        { error: `Backup failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
  }

  if (body?.action === "restore") {
    const result = restoreBackup(body.name ?? "");
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
