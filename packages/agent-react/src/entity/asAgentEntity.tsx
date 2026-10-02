import React from 'react';
import { AgentEntity } from './AgentEntity.js';
import type { AgentEntityChildContext } from './AgentEntity.js';
import type {
  EntityCapabilities,
  EntityDisplayContext,
  AgentAction,
  AgentCommand,
  AgentCommandResponse,
  UserObservation,
} from '@ouispec/agent-core';

/**
 * Configuration for the asAgentEntity HOC.
 */
export interface AsAgentEntityConfig<P> {
  entityType: string | ((props: P) => string);
  entityId: (props: P) => string;
  intents?: string[] | ((props: P) => string[]);
  displayContext: (props: P) => EntityDisplayContext;
  capabilities?: EntityCapabilities;
  onTargeted?: (props: P, action: AgentAction) => void;
  onReleased?: (props: P) => void;
  onCommandReceived?: (props: P, command: AgentCommand) => AgentCommandResponse | Promise<AgentCommandResponse> | void;
  onObserve?: (props: P, observation: UserObservation) => void;
}

/**
 * Props injected into the wrapped component by asAgentEntity.
 */
export interface InjectedAgentEntityProps {
  agentEntity: AgentEntityChildContext;
}

/**
 * asAgentEntity — Higher-Order Component that wraps an existing component with agent entity capabilities.
 *
 * Best for wrapping third-party components or components you can't modify.
 *
 * Example:
 * ```tsx
 * import { ThirdPartyCard } from 'some-library';
 *
 * const AgentThirdPartyCard = asAgentEntity({
 *   entityType: 'Character',
 *   entityId: (props) => props.character.id,
 *   displayContext: (props) => ({ label: props.character.name }),
 *   intents: ['generate-clip', 'clone-voice'],
 * })(ThirdPartyCard);
 *
 * // Usage:
 * <AgentThirdPartyCard character={char} />
 * ```
 */
export function asAgentEntity<P extends Record<string, unknown>>(
  config: AsAgentEntityConfig<P>,
) {
  return function wrap(
    WrappedComponent: React.ComponentType<P & Partial<InjectedAgentEntityProps>>,
  ): React.FC<P> {
    const WithAgentEntity: React.FC<P> = (props) => {
      const resolvedType = typeof config.entityType === 'function'
        ? config.entityType(props)
        : config.entityType;
      const resolvedId = config.entityId(props);
      const resolvedIntents = typeof config.intents === 'function'
        ? config.intents(props)
        : (config.intents ?? []);
      const resolvedDisplay = config.displayContext(props);

      return React.createElement(
        AgentEntity,
        {
          type: resolvedType,
          id: resolvedId,
          intents: resolvedIntents,
          displayContext: resolvedDisplay,
          capabilities: config.capabilities,
          onTargeted: config.onTargeted ? (action: AgentAction) => config.onTargeted!(props, action) : undefined,
          onReleased: config.onReleased ? () => config.onReleased!(props) : undefined,
          onCommandReceived: config.onCommandReceived ? (cmd: AgentCommand) => config.onCommandReceived!(props, cmd) : undefined,
          onObserve: config.onObserve ? (obs: UserObservation) => config.onObserve!(props, obs) : undefined,
          children: (context: AgentEntityChildContext) => React.createElement(
            WrappedComponent,
            { ...props, agentEntity: context },
          ),
        },
      );
    };

    WithAgentEntity.displayName = `asAgentEntity(${WrappedComponent.displayName || WrappedComponent.name || 'Component'})`;
    return WithAgentEntity;
  };
}
