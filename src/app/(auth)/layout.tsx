import Image from "next/image";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-16">
      <Image src="/madaket-dog-sketch.png" alt="" width={66} height={100} priority className="mb-6 opacity-90" />
      <h1 className="font-serif text-4xl text-cream">Madaket Gen Studio</h1>
      <p className="mt-2 text-sm text-cream-2">Image and video generation for Madaket Brands</p>
      <div className="mt-10 w-full max-w-sm">{children}</div>
    </main>
  );
}
