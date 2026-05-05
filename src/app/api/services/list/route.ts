import { loadServicesConfig } from '@/lib/servicesConfig';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const services = loadServicesConfig();
  // Return only key + label — don't expose unit names or probe URLs to the client
  return Response.json({
    services: services.map((s) => ({ key: s.key, label: s.label })),
  });
}
