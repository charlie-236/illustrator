export interface ServiceConfig {
  key: string;        // SERVICE_N_KEY — stable identifier for API contracts
  unit: string;       // SERVICE_N_UNIT — systemctl unit name
  probeUrl: string;   // SERVICE_N_PROBE_URL — HTTP readiness check
  label: string;      // SERVICE_N_LABEL — human display name
}

const MAX_SERVICE_SLOTS = 5;

let cachedServices: ServiceConfig[] | null = null;

/**
 * Reads SERVICE_1_* through SERVICE_N_* from env and returns the configured
 * services in slot order. A slot is included only when ALL FOUR vars are set
 * and non-empty. Slots with any missing var are skipped silently.
 *
 * Cached after first read for the lifetime of the process.
 */
export function loadServicesConfig(): ServiceConfig[] {
  if (cachedServices !== null) return cachedServices;

  const services: ServiceConfig[] = [];
  for (let i = 1; i <= MAX_SERVICE_SLOTS; i++) {
    const key = process.env[`SERVICE_${i}_KEY`]?.trim();
    const unit = process.env[`SERVICE_${i}_UNIT`]?.trim();
    const probeUrl = process.env[`SERVICE_${i}_PROBE_URL`]?.trim();
    const label = process.env[`SERVICE_${i}_LABEL`]?.trim();

    // Slot must have ALL four vars set; otherwise skip.
    if (key && unit && probeUrl && label) {
      services.push({ key, unit, probeUrl, label });
    }
  }

  cachedServices = services;
  return services;
}

/**
 * Lookup a service by its key. Returns null if no service with that key exists.
 */
export function getServiceByKey(key: string): ServiceConfig | null {
  return loadServicesConfig().find((s) => s.key === key) ?? null;
}
