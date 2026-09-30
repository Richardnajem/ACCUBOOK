import { NextRequest, NextResponse } from "next/server";
import { deleteTrade, getTradeById, updateTrade } from "@/lib/db";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const trade = getTradeById(Number(id));
  if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  return NextResponse.json({ trade });
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await request.json();
  const trade = updateTrade(Number(id), body);
  if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
  return NextResponse.json({ trade });
}

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  deleteTrade(Number(id));
  return NextResponse.json({ message: "Trade deleted" });
}
