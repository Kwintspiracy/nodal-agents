import Sidebar from '@/components/Sidebar';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Sidebar />
      <main className="flex-1 w-full lg:ml-56 pt-[72px] lg:pt-4 p-3 sm:p-5 lg:p-8 min-w-0">
        {children}
      </main>
    </>
  );
}
