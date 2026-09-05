vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  ContainerProxy: class {},
  getContainer: (binding: DurableObjectNamespace, name: string) => binding.get(binding.idFromName(name)),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {},
}));

// Worker entrypoint tests only verify the Hono application. Avoid loading the
// Cloudflare-only Agents runtime in Vitest's Node environment.
vi.mock('agents', () => ({ Agent: class {} }));
