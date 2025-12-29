import type { App, GenericMessageEvent } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { analyzeQuestion } from '../agent/agent.ts';
import * as k8s from '../kubernetes/client.ts';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Store for command builder state (channel -> state)
const commandBuilderState = new Map<
  string,
  {
    action: string;
    namespace: string;
    resourceType: string;
    resourceName: string;
    messageTs: string;
    scaleReplicas?: number;
    pendingConfirmation?: boolean;
  }
>();

// Check if action requires confirmation
function isWriteAction(action: string): boolean {
  return ['delete', 'restart', 'scale'].includes(action);
}

// Available actions
const ACTIONS = [
  // READ actions (no confirmation needed)
  { text: 'get - List resources', value: 'get', write: false },
  { text: 'logs - View pod logs', value: 'logs', write: false },
  { text: 'logs-previous - View previous pod logs (crashed)', value: 'logs-previous', write: false },
  { text: 'describe - Resource details', value: 'describe', write: false },
  { text: 'top - CPU/Memory metrics', value: 'top', write: false },
  { text: 'events - K8s events', value: 'events', write: false },
  { text: 'rollout-status - Deployment rollout status', value: 'rollout-status', write: false },
  { text: 'rollout-history - Deployment revision history', value: 'rollout-history', write: false },
  // WRITE actions (confirmation required)
  { text: '[WRITE] delete - Delete a resource', value: 'delete', write: true },
  { text: '[WRITE] restart - Restart a deployment', value: 'restart', write: true },
  { text: '[WRITE] scale - Scale a deployment', value: 'scale', write: true },
];

// Resource types
const RESOURCE_TYPES = [
  { text: 'pods', value: 'pods' },
  { text: 'deployments', value: 'deployments' },
  { text: 'services', value: 'services' },
  { text: 'configmaps', value: 'configmaps' },
  { text: 'ingresses', value: 'ingresses' },
  { text: 'hpa', value: 'hpa' },
  { text: 'secrets', value: 'secrets' },
  { text: 'replicasets', value: 'replicasets' },
  { text: 'statefulsets', value: 'statefulsets' },
  { text: 'daemonsets', value: 'daemonsets' },
  { text: 'jobs', value: 'jobs' },
  { text: 'cronjobs', value: 'cronjobs' },
  { text: 'nodes', value: 'nodes' },
  { text: 'pvc', value: 'pvc' },
  { text: 'endpoints', value: 'endpoints' },
];

// Fetch thread history to build conversation context
async function getThreadHistory(
  client: WebClient,
  channel: string,
  threadTs: string,
  botUserId: string,
): Promise<ConversationMessage[]> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });

    if (!result.messages) return [];

    const history: ConversationMessage[] = [];

    for (const msg of result.messages) {
      if (!msg.text) continue;
      if (msg.text === '🔍 Looking into it...') continue;

      const isBot = msg.bot_id || msg.user === botUserId;
      const cleanText = msg.text
        .replace(/<@[A-Z0-9]+>/g, '')
        .replace(/\n\n_Tools used:.*$/s, '')
        .trim();

      if (!cleanText) continue;

      history.push({
        role: isBot ? 'assistant' : 'user',
        content: cleanText,
      });
    }

    return history;
  } catch (error) {
    console.error('Failed to fetch thread history:', error);
    return [];
  }
}

// Build the command builder message blocks
async function buildCommandBuilderBlocks(
  selectedAction?: string,
  selectedNamespace?: string,
  selectedResourceType?: string,
  selectedResourceName?: string,
) {
  // Fetch namespaces
  let namespaces: string[] = [];
  try {
    namespaces = await k8s.getNamespaces();
  } catch {
    namespaces = ['services-prod', 'services-preprod', 'argocd'];
  }

  // Fetch resources based on selection
  let resources: string[] = [];
  if (selectedNamespace && selectedResourceType) {
    try {
      switch (selectedResourceType) {
        case 'pods': {
          const pods = await k8s.getPods(selectedNamespace);
          resources = pods.map((p) => p.name);
          break;
        }
        case 'deployments': {
          const deps = await k8s.getDeployments(selectedNamespace);
          resources = deps.map((d) => d.name);
          break;
        }
        case 'services': {
          const svcs = await k8s.getServices(selectedNamespace);
          resources = svcs.map((s) => s.name);
          break;
        }
        case 'configmaps': {
          const cms = await k8s.getConfigMaps(selectedNamespace);
          resources = cms.map((c) => c.name);
          break;
        }
        case 'ingresses': {
          const ings = await k8s.getIngresses(selectedNamespace);
          resources = ings.map((i) => i.name);
          break;
        }
        case 'hpa': {
          const hpas = await k8s.getHPAs(selectedNamespace);
          resources = hpas.map((h) => h.name);
          break;
        }
        case 'secrets': {
          const secrets = await k8s.getSecrets(selectedNamespace);
          resources = secrets.map((s) => s.name);
          break;
        }
        case 'replicasets': {
          const rss = await k8s.getReplicaSets(selectedNamespace);
          resources = rss.map((r) => r.name);
          break;
        }
        case 'statefulsets': {
          const sss = await k8s.getStatefulSets(selectedNamespace);
          resources = sss.map((s) => s.name);
          break;
        }
        case 'daemonsets': {
          const dss = await k8s.getDaemonSets(selectedNamespace);
          resources = dss.map((d) => d.name);
          break;
        }
        case 'jobs': {
          const jobs = await k8s.getJobs(selectedNamespace);
          resources = jobs.map((j) => j.name);
          break;
        }
        case 'cronjobs': {
          const cjs = await k8s.getCronJobs(selectedNamespace);
          resources = cjs.map((c) => c.name);
          break;
        }
        case 'pvc': {
          const pvcs = await k8s.getPVCs(selectedNamespace);
          resources = pvcs.map((p) => p.name);
          break;
        }
        case 'endpoints': {
          const eps = await k8s.getEndpoints(selectedNamespace);
          resources = eps.map((e) => e.name);
          break;
        }
        case 'nodes': {
          // Nodes are cluster-wide, not namespaced
          const nodes = await k8s.getNodes();
          resources = nodes.map((n) => n.name);
          break;
        }
        default:
          resources = [];
      }
    } catch {
      resources = [];
    }
  }

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Kubernetes Command Builder',
        emoji: false,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Select options to build your kubectl command:',
      },
    },
    {
      type: 'divider',
    },
    // Action selector
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Action:*',
      },
      accessory: {
        type: 'static_select',
        action_id: 'cmd_action',
        placeholder: {
          type: 'plain_text',
          text: 'Choose an action',
        },
        options: ACTIONS.map((a) => ({
          text: { type: 'plain_text', text: a.text, emoji: true },
          value: a.value,
        })),
        ...(selectedAction && {
          initial_option: {
            text: {
              type: 'plain_text',
              text: ACTIONS.find((a) => a.value === selectedAction)?.text || selectedAction,
              emoji: true,
            },
            value: selectedAction,
          },
        }),
      },
    },
    // Namespace selector
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Namespace:*',
      },
      accessory: {
        type: 'static_select',
        action_id: 'cmd_namespace',
        placeholder: {
          type: 'plain_text',
          text: 'Choose a namespace',
        },
        options: namespaces.slice(0, 100).map((ns) => ({
          text: { type: 'plain_text', text: ns },
          value: ns,
        })),
        ...(selectedNamespace && {
          initial_option: {
            text: { type: 'plain_text', text: selectedNamespace },
            value: selectedNamespace,
          },
        }),
      },
    },
    // Resource type selector
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Resource Type:*',
      },
      accessory: {
        type: 'static_select',
        action_id: 'cmd_resource_type',
        placeholder: {
          type: 'plain_text',
          text: 'Choose a type',
        },
        options: RESOURCE_TYPES.map((r) => ({
          text: { type: 'plain_text', text: r.text, emoji: true },
          value: r.value,
        })),
        ...(selectedResourceType && {
          initial_option: {
            text: {
              type: 'plain_text',
              text: RESOURCE_TYPES.find((r) => r.value === selectedResourceType)?.text || selectedResourceType,
              emoji: true,
            },
            value: selectedResourceType,
          },
        }),
      },
    },
  ];

  // Resource name selector (only if we have resources)
  if (resources.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Resource Name:*',
      },
      accessory: {
        type: 'static_select',
        action_id: 'cmd_resource_name',
        placeholder: {
          type: 'plain_text',
          text: 'Choose a resource',
        },
        options: resources.slice(0, 100).map((r) => ({
          text: { type: 'plain_text', text: r.length > 75 ? `${r.substring(0, 72)}...` : r },
          value: r.length > 75 ? r.substring(0, 75) : r,
        })),
        ...(selectedResourceName && {
          initial_option: {
            text: {
              type: 'plain_text',
              text:
                selectedResourceName.length > 75 ? `${selectedResourceName.substring(0, 72)}...` : selectedResourceName,
            },
            value: selectedResourceName.length > 75 ? selectedResourceName.substring(0, 75) : selectedResourceName,
          },
        }),
      },
    } as (typeof blocks)[number]);
  }

  // Command preview
  let commandPreview = 'kubectl';
  if (selectedAction === 'restart') {
    commandPreview = `kubectl rollout restart`;
  } else if (selectedAction === 'scale') {
    commandPreview = `kubectl scale --replicas=?`;
  } else if (selectedAction) {
    commandPreview += ` ${selectedAction}`;
  }
  if (selectedResourceType) commandPreview += ` ${selectedResourceType}`;
  if (selectedResourceName) commandPreview += ` ${selectedResourceName}`;
  if (selectedNamespace) commandPreview += ` -n ${selectedNamespace}`;

  const isWrite = selectedAction ? isWriteAction(selectedAction) : false;

  blocks.push({
    type: 'divider',
  } as (typeof blocks)[number]);

  // Warning for write actions
  if (isWrite) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*WARNING: This is a WRITE operation that will modify the cluster!*`,
      },
    } as (typeof blocks)[number]);
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Command:* \`${commandPreview}\``,
    },
  } as (typeof blocks)[number]);

  // Scale replicas input (only for scale action)
  if (selectedAction === 'scale') {
    blocks.push({
      type: 'input',
      block_id: 'scale_replicas_block',
      element: {
        type: 'number_input',
        action_id: 'cmd_scale_replicas',
        is_decimal_allowed: false,
        min_value: '0',
        max_value: '100',
        placeholder: {
          type: 'plain_text',
          text: 'Number of replicas',
        },
      },
      label: {
        type: 'plain_text',
        text: 'Replicas:',
      },
    } as (typeof blocks)[number]);
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: isWrite ? 'CONFIRM' : 'Execute',
          emoji: false,
        },
        style: isWrite ? 'danger' : 'primary',
        action_id: 'cmd_execute',
        ...(isWrite && {
          confirm: {
            title: { type: 'plain_text', text: 'Are you sure?' },
            text: {
              type: 'mrkdwn',
              text: `You are about to *${selectedAction}* \`${selectedResourceName || selectedResourceType}\` in \`${selectedNamespace}\`. This action cannot be undone.`,
            },
            confirm: { type: 'plain_text', text: 'Yes, do it' },
            deny: { type: 'plain_text', text: 'Cancel' },
            style: 'danger',
          },
        }),
        value: JSON.stringify({
          action: selectedAction,
          namespace: selectedNamespace,
          resourceType: selectedResourceType,
          resourceName: selectedResourceName,
        }),
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: false,
        },
        style: 'danger',
        action_id: 'cmd_cancel',
      },
    ],
  } as (typeof blocks)[number]);

  return blocks;
}

// Execute the kubectl command
async function executeCommand(
  action: string,
  namespace: string,
  resourceType: string,
  resourceName?: string,
): Promise<string> {
  try {
    switch (action) {
      case 'get': {
        switch (resourceType) {
          case 'pods': {
            const pods = await k8s.getPods(namespace);
            if (pods.length === 0) return 'No pods found';
            return pods.map((p) => `${p.name} | ${p.status} | Restarts: ${p.restarts} | Age: ${p.age}`).join('\n');
          }
          case 'deployments': {
            const deps = await k8s.getDeployments(namespace);
            if (deps.length === 0) return 'No deployments found';
            return deps.map((d) => `${d.name} | Replicas: ${d.replicas}`).join('\n');
          }
          case 'services': {
            const svcs = await k8s.getServices(namespace);
            if (svcs.length === 0) return 'No services found';
            return svcs.map((s) => `${s.name} | ${s.type} | ${s.clusterIP} | Ports: ${s.ports}`).join('\n');
          }
          case 'configmaps': {
            const cms = await k8s.getConfigMaps(namespace);
            if (cms.length === 0) return 'No configmaps found';
            return cms.map((c) => `${c.name} | Keys: ${c.dataKeys.join(', ')}`).join('\n');
          }
          case 'ingresses': {
            const ings = await k8s.getIngresses(namespace);
            if (ings.length === 0) return 'No ingresses found';
            return ings.map((i) => `${i.name} | Hosts: ${i.hosts.join(', ')}`).join('\n');
          }
          case 'hpa': {
            const hpas = await k8s.getHPAs(namespace);
            if (hpas.length === 0) return 'No HPAs found';
            return hpas
              .map((h) => `${h.name} | Target: ${h.target} | ${h.currentReplicas}/${h.minReplicas}-${h.maxReplicas}`)
              .join('\n');
          }
          case 'secrets': {
            const secrets = await k8s.getSecrets(namespace);
            if (secrets.length === 0) return 'No secrets found';
            return secrets.map((s) => `${s.name} | Type: ${s.type} | Keys: ${s.dataKeys}`).join('\n');
          }
          case 'replicasets': {
            const rss = await k8s.getReplicaSets(namespace);
            if (rss.length === 0) return 'No replicasets found';
            return rss.map((r) => `${r.name} | Replicas: ${r.replicas} | Age: ${r.age}`).join('\n');
          }
          case 'statefulsets': {
            const sss = await k8s.getStatefulSets(namespace);
            if (sss.length === 0) return 'No statefulsets found';
            return sss.map((s) => `${s.name} | Replicas: ${s.replicas} | Age: ${s.age}`).join('\n');
          }
          case 'daemonsets': {
            const dss = await k8s.getDaemonSets(namespace);
            if (dss.length === 0) return 'No daemonsets found';
            return dss.map((d) => `${d.name} | Desired: ${d.desired} | Ready: ${d.ready} | Age: ${d.age}`).join('\n');
          }
          case 'jobs': {
            const jobs = await k8s.getJobs(namespace);
            if (jobs.length === 0) return 'No jobs found';
            return jobs.map((j) => `${j.name} | ${j.completions} | ${j.status} | Age: ${j.age}`).join('\n');
          }
          case 'cronjobs': {
            const cjs = await k8s.getCronJobs(namespace);
            if (cjs.length === 0) return 'No cronjobs found';
            return cjs
              .map((c) => `${c.name} | Schedule: ${c.schedule} | Last: ${c.lastSchedule} | Active: ${c.active}`)
              .join('\n');
          }
          case 'nodes': {
            const nodes = await k8s.getNodes();
            if (nodes.length === 0) return 'No nodes found';
            return nodes
              .map((n) => `${n.name} | ${n.status} | Roles: ${n.roles} | Version: ${n.version} | Age: ${n.age}`)
              .join('\n');
          }
          case 'pvc': {
            const pvcs = await k8s.getPVCs(namespace);
            if (pvcs.length === 0) return 'No PVCs found';
            return pvcs
              .map((p) => `${p.name} | ${p.status} | ${p.capacity} | StorageClass: ${p.storageClass}`)
              .join('\n');
          }
          case 'endpoints': {
            const eps = await k8s.getEndpoints(namespace);
            if (eps.length === 0) return 'No endpoints found';
            return eps.map((e) => `${e.name} | Endpoints: ${e.endpoints}`).join('\n');
          }
          default:
            return `Unsupported resource type: ${resourceType}`;
        }
      }

      case 'logs': {
        if (!resourceName) return 'Pod name required for logs';
        return await k8s.getPodLogs(resourceName, namespace, 100);
      }

      case 'logs-previous': {
        if (!resourceName) return 'Pod name required for previous logs';
        return await k8s.getPreviousPodLogs(resourceName, namespace, 100);
      }

      case 'describe': {
        if (!resourceName) return 'Resource name required';
        if (resourceType === 'pods') {
          return await k8s.describePod(resourceName, namespace);
        }
        if (resourceType === 'configmaps') {
          return await k8s.describeConfigMap(resourceName, namespace);
        }
        return `Describe not supported for: ${resourceType}`;
      }

      case 'top': {
        const metrics = await k8s.getPodMetrics(namespace);
        if (metrics.length === 0) return 'No metrics available';
        return metrics.map((m) => `${m.name} | CPU: ${m.cpu} | Memory: ${m.memory}`).join('\n');
      }

      case 'events': {
        const events = await k8s.getEvents(namespace);
        if (events.length === 0) return 'No recent events';
        return events
          .slice(0, 20)
          .map((e) => `[${e.type}] ${e.reason} on ${e.involvedObject}: ${e.message}`)
          .join('\n');
      }

      case 'rollout-status': {
        if (!resourceName) return 'Deployment name required';
        if (resourceType !== 'deployments') return 'Rollout status only works with deployments';
        return await k8s.getRolloutStatus(resourceName, namespace);
      }

      case 'rollout-history': {
        if (!resourceName) return 'Deployment name required';
        if (resourceType !== 'deployments') return 'Rollout history only works with deployments';
        return await k8s.getRolloutHistory(resourceName, namespace);
      }

      // WRITE OPERATIONS
      case 'delete': {
        if (!resourceName) return 'Resource name required for delete';
        switch (resourceType) {
          case 'pods':
            return await k8s.deletePod(resourceName, namespace);
          case 'deployments':
            return await k8s.deleteDeployment(resourceName, namespace);
          case 'services':
            return await k8s.deleteService(resourceName, namespace);
          case 'configmaps':
            return await k8s.deleteConfigMap(resourceName, namespace);
          case 'jobs':
            return await k8s.deleteJob(resourceName, namespace);
          default:
            return `Delete not supported for: ${resourceType}`;
        }
      }

      case 'restart': {
        if (!resourceName) return 'Deployment name required for restart';
        if (resourceType !== 'deployments') return 'Restart only works with deployments';
        return await k8s.restartDeployment(resourceName, namespace);
      }

      case 'scale': {
        if (!resourceName) return 'Deployment name required for scale';
        if (resourceType !== 'deployments') return 'Scale only works with deployments';
        // scaleReplicas is passed via options
        return 'Scale requires replicas parameter - use the number input';
      }

      default:
        return `Unsupported action: ${action}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Execute with scale replicas
async function executeCommandWithScale(
  action: string,
  namespace: string,
  resourceType: string,
  resourceName: string,
  replicas: number,
): Promise<string> {
  try {
    if (action === 'scale' && resourceType === 'deployments') {
      return await k8s.scaleDeployment(resourceName, namespace, replicas);
    }
    return 'Invalid scale operation';
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function registerHandlers(app: App): void {
  let botUserId: string | undefined;

  // Get bot user ID on startup
  app.client.auth.test().then((result) => {
    botUserId = result.user_id;
    console.log(`🤖 Bot user ID: ${botUserId}`);
  });

  // Handle "command" keyword to open command builder
  app.event('app_mention', async ({ event, say, client }) => {
    const text = event.text || '';
    const question = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    // Check if user wants the command builder
    if (question.toLowerCase() === 'command' || question.toLowerCase() === 'cmd') {
      console.log('📩 Command builder requested');

      const blocks = await buildCommandBuilderBlocks();
      const result = await client.chat.postMessage({
        channel: event.channel,
        text: '🔧 Kubernetes Command Builder',
        blocks,
        thread_ts: event.ts,
      });

      // Store initial state
      commandBuilderState.set(`${event.channel}:${result.ts}`, {
        action: '',
        namespace: '',
        resourceType: '',
        resourceName: '',
        messageTs: result.ts!,
      });

      return;
    }

    if (!question) {
      await say({
        text: "👋 Hey! Ask me anything about the Kubernetes cluster and I'll investigate for you.\n\nCommands:\n• `@bot command` - Open the interactive command builder\n• `@bot <question>` - Ask a question in natural language",
        thread_ts: event.ts,
      });
      return;
    }

    // Regular question handling
    const threadTs = event.thread_ts || event.ts;
    const isThreadReply = !!event.thread_ts;

    console.log(`📩 Question received: "${question}" (thread: ${isThreadReply})`);

    const thinkingMsg = await client.chat.postMessage({
      channel: event.channel,
      text: '🔍 Looking into it...',
      thread_ts: threadTs,
    });

    try {
      let conversationHistory: ConversationMessage[] = [];
      if (isThreadReply && botUserId) {
        conversationHistory = await getThreadHistory(client, event.channel, threadTs, botUserId);
        if (conversationHistory.length > 0) {
          conversationHistory.pop();
        }
        console.log(`📜 Thread history: ${conversationHistory.length} messages`);
      }

      const startTime = Date.now();
      const result = await analyzeQuestion(question, conversationHistory);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      const toolsInfo =
        result.toolsUsed.length > 0 ? `\n\n_Tools used: ${result.toolsUsed.join(', ')} (${duration}s)_` : '';

      await client.chat.update({
        channel: event.channel,
        ts: thinkingMsg.ts!,
        text: result.answer + toolsInfo,
      });

      console.log(`✅ Response sent (${duration}s)`);
    } catch (error) {
      console.error('❌ Error analyzing question:', error);

      await client.chat.update({
        channel: event.channel,
        ts: thinkingMsg.ts!,
        text: `❌ Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Handle action selector
  app.action('cmd_action', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (action.type !== 'static_select') return;

    const selectedAction = action.selected_option?.value || '';
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    if (!channel || !messageTs) return;

    const stateKey = `${channel}:${messageTs}`;
    const state = commandBuilderState.get(stateKey) || {
      action: '',
      namespace: '',
      resourceType: '',
      resourceName: '',
      messageTs,
    };

    state.action = selectedAction;
    commandBuilderState.set(stateKey, state);

    const blocks = await buildCommandBuilderBlocks(
      state.action,
      state.namespace,
      state.resourceType,
      state.resourceName,
    );

    await client.chat.update({
      channel,
      ts: messageTs,
      text: '🔧 Kubernetes Command Builder',
      blocks,
    });
  });

  // Handle namespace selector
  app.action('cmd_namespace', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (action.type !== 'static_select') return;

    const selectedNamespace = action.selected_option?.value || '';
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    if (!channel || !messageTs) return;

    const stateKey = `${channel}:${messageTs}`;
    const state = commandBuilderState.get(stateKey) || {
      action: '',
      namespace: '',
      resourceType: '',
      resourceName: '',
      messageTs,
    };

    state.namespace = selectedNamespace;
    state.resourceName = ''; // Reset resource name when namespace changes
    commandBuilderState.set(stateKey, state);

    const blocks = await buildCommandBuilderBlocks(
      state.action,
      state.namespace,
      state.resourceType,
      state.resourceName,
    );

    await client.chat.update({
      channel,
      ts: messageTs,
      text: '🔧 Kubernetes Command Builder',
      blocks,
    });
  });

  // Handle resource type selector
  app.action('cmd_resource_type', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (action.type !== 'static_select') return;

    const selectedResourceType = action.selected_option?.value || '';
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    if (!channel || !messageTs) return;

    const stateKey = `${channel}:${messageTs}`;
    const state = commandBuilderState.get(stateKey) || {
      action: '',
      namespace: '',
      resourceType: '',
      resourceName: '',
      messageTs,
    };

    state.resourceType = selectedResourceType;
    state.resourceName = ''; // Reset resource name when type changes
    commandBuilderState.set(stateKey, state);

    const blocks = await buildCommandBuilderBlocks(
      state.action,
      state.namespace,
      state.resourceType,
      state.resourceName,
    );

    await client.chat.update({
      channel,
      ts: messageTs,
      text: '🔧 Kubernetes Command Builder',
      blocks,
    });
  });

  // Handle resource name selector
  app.action('cmd_resource_name', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (action.type !== 'static_select') return;

    const selectedResourceName = action.selected_option?.value || '';
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    if (!channel || !messageTs) return;

    const stateKey = `${channel}:${messageTs}`;
    const state = commandBuilderState.get(stateKey) || {
      action: '',
      namespace: '',
      resourceType: '',
      resourceName: '',
      messageTs,
    };

    state.resourceName = selectedResourceName;
    commandBuilderState.set(stateKey, state);

    const blocks = await buildCommandBuilderBlocks(
      state.action,
      state.namespace,
      state.resourceType,
      state.resourceName,
    );

    await client.chat.update({
      channel,
      ts: messageTs,
      text: '🔧 Kubernetes Command Builder',
      blocks,
    });
  });

  // Handle execute button
  app.action('cmd_execute', async ({ ack, body, client, say }) => {
    await ack();
    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (action.type !== 'button') return;

    const channel = body.channel?.id;
    const messageTs = body.message?.ts;
    const threadTs = (body.message as { thread_ts?: string })?.thread_ts;

    if (!channel || !messageTs) return;

    const stateKey = `${channel}:${messageTs}`;
    const state = commandBuilderState.get(stateKey);

    if (!state || !state.action || !state.namespace || !state.resourceType) {
      await client.chat.postMessage({
        channel,
        text: '⚠️ Please select at least an action, namespace, and resource type.',
        thread_ts: threadTs || messageTs,
      });
      return;
    }

    // Get scale replicas from state (if scale action)
    let scaleReplicas: number | undefined;
    if (state.action === 'scale') {
      // Try to get replicas from the message state
      const messageState = body.state?.values?.['scale_replicas_block']?.['cmd_scale_replicas'];
      if (messageState && 'value' in messageState) {
        scaleReplicas = Number.parseInt(messageState.value || '0', 10);
      }
      if (scaleReplicas === undefined || Number.isNaN(scaleReplicas)) {
        await client.chat.postMessage({
          channel,
          text: '⚠️ Please enter the number of replicas for scale operation.',
          thread_ts: threadTs || messageTs,
        });
        return;
      }
    }

    // Build command string for display
    let commandStr: string;
    if (state.action === 'restart') {
      commandStr = `kubectl rollout restart deployment ${state.resourceName} -n ${state.namespace}`;
    } else if (state.action === 'scale') {
      commandStr = `kubectl scale deployment ${state.resourceName} --replicas=${scaleReplicas} -n ${state.namespace}`;
    } else {
      commandStr = `kubectl ${state.action} ${state.resourceType}`;
      if (state.resourceName) commandStr += ` ${state.resourceName}`;
      commandStr += ` -n ${state.namespace}`;
    }

    const isWrite = isWriteAction(state.action);

    // Execute the command
    console.log(`${isWrite ? '⚠️ WRITE' : '🚀'} Executing: ${commandStr}`);

    let result: string;
    if (state.action === 'scale' && scaleReplicas !== undefined) {
      result = await executeCommandWithScale(
        state.action,
        state.namespace,
        state.resourceType,
        state.resourceName || '',
        scaleReplicas,
      );
    } else {
      result = await executeCommand(state.action, state.namespace, state.resourceType, state.resourceName);
    }

    // Truncate result if too long
    const maxLength = 2900;
    const truncatedResult =
      result.length > maxLength ? `${result.substring(0, maxLength)}...\n\n_[Output truncated]_` : result;

    const prefix = isWrite ? '⚠️ *[WRITE]*' : '✅';
    await client.chat.postMessage({
      channel,
      text: `${prefix} *Command:* \`${commandStr}\`\n\n\`\`\`\n${truncatedResult}\n\`\`\``,
      thread_ts: threadTs || messageTs,
    });

    // Clean up state
    commandBuilderState.delete(stateKey);
  });

  // Handle cancel button
  app.action('cmd_cancel', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions') return;

    const channel = body.channel?.id;
    const messageTs = body.message?.ts;

    if (!channel || !messageTs) return;

    const stateKey = `${channel}:${messageTs}`;
    commandBuilderState.delete(stateKey);

    await client.chat.update({
      channel,
      ts: messageTs,
      text: '❌ Command builder closed.',
      blocks: [],
    });
  });

  // Handle direct messages
  app.event('message', async ({ event, client }) => {
    const msgEvent = event as GenericMessageEvent;
    if (msgEvent.channel_type !== 'im') return;
    if (msgEvent.subtype) return;

    const question = msgEvent.text?.trim();
    if (!question) return;

    const threadTs = msgEvent.thread_ts || msgEvent.ts;
    const isThreadReply = !!msgEvent.thread_ts;

    console.log(`📩 DM received: "${question}" (thread: ${isThreadReply})`);

    const thinkingMsg = await client.chat.postMessage({
      channel: msgEvent.channel,
      text: '🔍 Looking into it...',
      thread_ts: threadTs,
    });

    try {
      let conversationHistory: ConversationMessage[] = [];
      if (isThreadReply && botUserId) {
        conversationHistory = await getThreadHistory(client, msgEvent.channel, threadTs, botUserId);
        if (conversationHistory.length > 0) {
          conversationHistory.pop();
        }
        console.log(`📜 Thread history: ${conversationHistory.length} messages`);
      }

      const startTime = Date.now();
      const result = await analyzeQuestion(question, conversationHistory);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      const toolsInfo =
        result.toolsUsed.length > 0 ? `\n\n_Tools used: ${result.toolsUsed.join(', ')} (${duration}s)_` : '';

      await client.chat.update({
        channel: msgEvent.channel,
        ts: thinkingMsg.ts!,
        text: result.answer + toolsInfo,
      });

      console.log(`✅ Response sent (${duration}s)`);
    } catch (error) {
      console.error('❌ Error analyzing question:', error);

      await client.chat.update({
        channel: msgEvent.channel,
        ts: thinkingMsg.ts!,
        text: `❌ Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Health check command
  app.command('/kube-health', async ({ ack, respond }) => {
    await ack();
    await respond({
      text: '✅ Kube-bot is running and ready to help!',
      response_type: 'ephemeral',
    });
  });
}
