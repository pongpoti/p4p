import { NextResponse } from "next/server"
import { withAdmin } from "@/lib/admin/handler"
import { listAccessRequests } from "@/lib/admin/access-requests"

export const runtime = "nodejs"

export const GET = withAdmin(async () => {
  const requests = await listAccessRequests()
  return NextResponse.json({ requests })
})
