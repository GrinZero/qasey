export type TriggerConnectionStatus = "awaiting_webhook" | "active" | "disabled" | "error";
export type TriggerTargetKind = "agent" | "workflow";

export interface TriggerConfigurationField {
  key: string;
  label: string;
  type: "text" | "secret" | "boolean";
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface TriggerProviderManifest {
  id: string;
  name: string;
  description: string;
  category: "channel" | "webhook" | "schedule" | "event-source";
  configurationTitle: string;
  configurationDescription: string;
  fields: readonly TriggerConfigurationField[];
  capabilities: {
    configurationUpdate: boolean;
    enableDisable: boolean;
    rebind: boolean;
    delete: boolean;
  };
}

export interface TriggerTarget {
  id: string;
  applicationId: string;
  kind: TriggerTargetKind;
  resourceId: string;
  name: string;
}

export interface TriggerConnection {
  id: string;
  providerId: string;
  providerName: string;
  displayName: string;
  status: TriggerConnectionStatus;
  statusDetail: string;
  revision: number;
  target: TriggerTarget;
  identity?: {
    label: string;
    value: string;
    context?: string;
  };
  endpoint?: {
    label: string;
    url: string;
  };
  setupFields?: readonly {
    key: string;
    label: string;
    value: string;
    copyable?: boolean;
  }[];
  configurationValues?: Readonly<Record<string, string>>;
  guidance?: {
    title: string;
    body: string;
    codes?: readonly string[];
  };
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerMutationContext {
  tenantId: string;
  actorId: string;
}

export interface PlatformTriggerProvider {
  readonly manifest: TriggerProviderManifest;
  targets(tenantId: string): Promise<readonly TriggerTarget[]>;
  list(tenantId: string): Promise<readonly TriggerConnection[]>;
  create(input: TriggerMutationContext & {
    displayName: string;
    targetId: string;
    configuration: Readonly<Record<string, string>>;
  }): Promise<TriggerConnection>;
  updateConfiguration?(input: TriggerMutationContext & {
    id: string;
    revision: number;
    configuration: Readonly<Record<string, string>>;
  }): Promise<TriggerConnection>;
  rebind?(input: TriggerMutationContext & { id: string; revision: number; targetId: string }): Promise<TriggerConnection>;
  setEnabled?(input: TriggerMutationContext & { id: string; revision: number; enabled: boolean }): Promise<TriggerConnection>;
  delete?(input: TriggerMutationContext & { id: string; revision: number }): Promise<void>;
}

export class TriggerProviderError extends Error {
  constructor(
    readonly code: "unknown_provider" | "invalid_configuration" | "invalid_target" | "not_found" | "conflict" | "operation_not_supported",
    message: string,
  ) { super(message); }
}

export class TriggerProviderRegistry {
  private readonly providers = new Map<string, PlatformTriggerProvider>();

  constructor(providers: readonly PlatformTriggerProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.manifest.id)) throw new Error(`Duplicate trigger provider: ${provider.manifest.id}`);
      this.providers.set(provider.manifest.id, provider);
    }
  }

  listProviders(): readonly TriggerProviderManifest[] {
    return [...this.providers.values()].map(provider => provider.manifest);
  }

  targets(providerId: string, tenantId: string): Promise<readonly TriggerTarget[]> {
    return this.require(providerId).targets(tenantId);
  }

  async listConnections(tenantId: string): Promise<readonly TriggerConnection[]> {
    const connections = await Promise.all([...this.providers.values()].map(provider => provider.list(tenantId)));
    return connections.flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  create(providerId: string, input: Parameters<PlatformTriggerProvider["create"]>[0]): Promise<TriggerConnection> {
    return this.require(providerId).create(input);
  }

  updateConfiguration(providerId: string, input: TriggerMutationContext & {
    id: string; revision: number; configuration: Readonly<Record<string, string>>;
  }): Promise<TriggerConnection> {
    const provider = this.require(providerId);
    if (!provider.updateConfiguration) throw unsupported(providerId, "configuration updates");
    return provider.updateConfiguration(input);
  }

  rebind(providerId: string, input: TriggerMutationContext & { id: string; revision: number; targetId: string }): Promise<TriggerConnection> {
    const provider = this.require(providerId);
    if (!provider.rebind) throw unsupported(providerId, "target binding");
    return provider.rebind(input);
  }

  setEnabled(providerId: string, input: TriggerMutationContext & { id: string; revision: number; enabled: boolean }): Promise<TriggerConnection> {
    const provider = this.require(providerId);
    if (!provider.setEnabled) throw unsupported(providerId, "enable/disable");
    return provider.setEnabled(input);
  }

  async delete(providerId: string, input: TriggerMutationContext & { id: string; revision: number }): Promise<void> {
    const provider = this.require(providerId);
    if (!provider.delete) throw unsupported(providerId, "deletion");
    await provider.delete(input);
  }

  private require(providerId: string): PlatformTriggerProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new TriggerProviderError("unknown_provider", `Unknown trigger provider: ${providerId}`);
    return provider;
  }
}

function unsupported(providerId: string, operation: string): TriggerProviderError {
  return new TriggerProviderError("operation_not_supported", `${providerId} does not support ${operation}`);
}
