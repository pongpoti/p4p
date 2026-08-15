import { NextResponse } from "next/server"
import { withAdmin, type RouteContext } from "@/lib/admin/handler"
import { rejectAccessRequest } from "@/lib/admin/access-requests"

export const runtime = "nodejs"

type Ctx = RouteContext<{ email: string }>

export const POST = withAdmin(async (_request, { params }: Ctx) => {
  const { email } = await params
  await rejectAccessRequest(email.trim().toLowerCase())
  return NextResponse.json({ ok: true })
})
