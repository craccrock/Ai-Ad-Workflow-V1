import Image from "next/image";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <Image src="/affirm-aa.png" alt="" width={84} height={84} priority className="mb-6 opacity-90" />
      <h1 className="font-serif text-4xl text-cream">Affirm Gen Studio</h1>
      <p className="mt-2 text-sm text-cream-2">AI ad production for Affirm Acquisition</p>
      <div className="mt-10 w-full max-w-sm">{children}</div>
    </main>
  );
}
