import { NextRequest, NextResponse } from "next/server";
import { setSetting, getSettingsByPrefix } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Panel layouts live in SQLite so the layout you build survives restarts and
// syncs across every device pointed at the same portfolio.db.
// Key format: "panel-layout:<boardKey>" → JSON { order, collapsed }.

const PREFIX = "panel-layout:";

// GET /api/layouts — every saved board layout:
// { layouts: { [boardKey]: { order: string[], collapsed: Record<string, boolean> } } }
export async function GET() {
  try {
    const rows = getSettingsByPrefix(PREFIX);
    const layouts: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rows)) {
      try {
        layouts[key.slice(PREFIX.length)] = JSON.parse(value);
      } catch {
        // corrupted entry — skip it rather than fail the whole request
      }
    }
    return NextResponse.json({ layouts });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load layouts." },
      { status: 500 },
    );
  }
}

// PUT /api/layouts — save one board layout:
// body { boardKey: string; order: string[]; collapsed: Record<string, boolean> }
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const boardKey = String(body?.boardKey ?? "").trim();
    if (!boardKey || /[^\w-]/.test(boardKey)) {
      return NextResponse.json({ error: "Valid boardKey is required." }, { status: 400 });
    }
    const order = Array.isArray(body?.order) ? body.order.map(String) : null;
    if (!order) {
      return NextResponse.json({ error: "order (string[]) is required." }, { status: 400 });
    }
    const collapsed = body?.collapsed && typeof body.collapsed === "object" ? body.collapsed : {};

    setSetting(PREFIX + boardKey, JSON.stringify({ order, collapsed }));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to save layout." },
      { status: 500 },
    );
  }
}
