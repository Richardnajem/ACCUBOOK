import DashboardLayout from "@/app/dashboard/layout";

/**
 * The strategies pages live outside /dashboard because they predate it, but
 * they are part of the app — wrapping them in the dashboard chrome keeps the
 * sidebar, search and import button in place instead of dropping the user into
 * a bare page.
 */
export default function StrategiesLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
