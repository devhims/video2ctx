vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  ContainerProxy: class {},
  getContainer: (binding: DurableObjectNamespace, name: string) => binding.get(binding.idFromName(name)),
}));
