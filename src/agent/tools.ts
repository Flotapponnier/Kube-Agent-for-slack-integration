import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import * as k8s from '../kubernetes/client.ts';

// Tool definitions for OpenAI function calling
export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_pods',
      description:
        'List all pods in a namespace or all namespaces. Use this to see the state of pods, their status, and restart counts.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to list pods from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_pod',
      description:
        'Get detailed information about a specific pod including container specs, resource limits, and current state. Essential for diagnosing OOMKills, CrashLoops, etc.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the pod',
          },
          namespace: {
            type: 'string',
            description: 'The namespace of the pod',
          },
        },
        required: ['name', 'namespace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pod_logs',
      description: 'Get the logs from a pod. Use this to see error messages, exceptions, and application output.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the pod',
          },
          namespace: {
            type: 'string',
            description: 'The namespace of the pod',
          },
          tail_lines: {
            type: 'number',
            description: 'Number of lines to return from the end (default 100)',
          },
          container: {
            type: 'string',
            description: 'Container name if pod has multiple containers (optional)',
          },
        },
        required: ['name', 'namespace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_previous_pod_logs',
      description:
        'Get logs from the previous instance of a pod (before it crashed/restarted). Very useful for crash analysis.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the pod',
          },
          namespace: {
            type: 'string',
            description: 'The namespace of the pod',
          },
          tail_lines: {
            type: 'number',
            description: 'Number of lines to return from the end (default 100)',
          },
          container: {
            type: 'string',
            description: 'Container name if pod has multiple containers (optional)',
          },
        },
        required: ['name', 'namespace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_events',
      description:
        'Get recent Kubernetes events. Events show warnings, errors, OOMKills, scheduling issues, etc. This is usually the first thing to check.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to get events from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_deployments',
      description: 'List deployments to see replica counts and availability status.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to list deployments from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pod_metrics',
      description: 'Get current CPU and memory usage for pods. Useful to check if pods are near their limits.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to get metrics from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_namespaces',
      description: 'List all namespaces in the cluster.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_services',
      description: 'List Kubernetes services. Shows service type, cluster IP, and exposed ports.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to list services from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_configmaps',
      description: 'List ConfigMaps. Useful to see application configuration.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to list configmaps from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_configmap',
      description: 'Get the content of a specific ConfigMap. Shows all keys and their values.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the configmap',
          },
          namespace: {
            type: 'string',
            description: 'The namespace of the configmap',
          },
        },
        required: ['name', 'namespace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_ingresses',
      description: 'List Ingress resources. Shows hosts, paths, and routing rules.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to list ingresses from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_hpas',
      description: 'List HorizontalPodAutoscalers. Shows min/max replicas, current replicas, and scaling targets.',
      parameters: {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description: 'The namespace to list HPAs from. Leave empty for all namespaces.',
          },
        },
      },
    },
  },
];

// Tool execution
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'get_pods': {
        const pods = await k8s.getPods(args['namespace'] as string | undefined);
        if (pods.length === 0) return 'No pods found';
        return pods
          .map((p) => `${p.namespace}/${p.name} | Status: ${p.status} | Restarts: ${p.restarts} | Age: ${p.age}`)
          .join('\n');
      }

      case 'describe_pod': {
        return await k8s.describePod(args['name'] as string, args['namespace'] as string);
      }

      case 'get_pod_logs': {
        return await k8s.getPodLogs(
          args['name'] as string,
          args['namespace'] as string,
          (args['tail_lines'] as number) || 100,
          args['container'] as string | undefined,
        );
      }

      case 'get_previous_pod_logs': {
        return await k8s.getPreviousPodLogs(
          args['name'] as string,
          args['namespace'] as string,
          (args['tail_lines'] as number) || 100,
          args['container'] as string | undefined,
        );
      }

      case 'get_events': {
        const events = await k8s.getEvents(args['namespace'] as string | undefined);
        if (events.length === 0) return 'No recent events';
        return events
          .map((e) => `[${e.type}] ${e.reason} on ${e.involvedObject}: ${e.message} (x${e.count}, ${e.lastTimestamp})`)
          .join('\n');
      }

      case 'get_deployments': {
        const deployments = await k8s.getDeployments(args['namespace'] as string | undefined);
        if (deployments.length === 0) return 'No deployments found';
        return deployments.map((d) => `${d.namespace}/${d.name} | Replicas: ${d.replicas}`).join('\n');
      }

      case 'get_pod_metrics': {
        const metrics = await k8s.getPodMetrics(args['namespace'] as string | undefined);
        if (metrics.length === 0) return 'No metrics available (metrics-server may not be installed)';
        return metrics.map((m) => `${m.namespace}/${m.name} | CPU: ${m.cpu} | Memory: ${m.memory}`).join('\n');
      }

      case 'get_namespaces': {
        const namespaces = await k8s.getNamespaces();
        return namespaces.join('\n');
      }

      case 'get_services': {
        const services = await k8s.getServices(args['namespace'] as string | undefined);
        if (services.length === 0) return 'No services found';
        return services
          .map((s) => `${s.namespace}/${s.name} | Type: ${s.type} | ClusterIP: ${s.clusterIP} | Ports: ${s.ports}`)
          .join('\n');
      }

      case 'get_configmaps': {
        const configmaps = await k8s.getConfigMaps(args['namespace'] as string | undefined);
        if (configmaps.length === 0) return 'No configmaps found';
        return configmaps
          .map((cm) => `${cm.namespace}/${cm.name} | Keys: ${cm.dataKeys.join(', ') || 'none'}`)
          .join('\n');
      }

      case 'describe_configmap': {
        return await k8s.describeConfigMap(args['name'] as string, args['namespace'] as string);
      }

      case 'get_ingresses': {
        const ingresses = await k8s.getIngresses(args['namespace'] as string | undefined);
        if (ingresses.length === 0) return 'No ingresses found';
        return ingresses
          .map((i) => `${i.namespace}/${i.name} | Hosts: ${i.hosts.join(', ')} | Paths: ${i.paths}`)
          .join('\n');
      }

      case 'get_hpas': {
        const hpas = await k8s.getHPAs(args['namespace'] as string | undefined);
        if (hpas.length === 0) return 'No HPAs found';
        return hpas
          .map(
            (h) =>
              `${h.namespace}/${h.name} | Target: ${h.target} | Replicas: ${h.currentReplicas}/${h.minReplicas}-${h.maxReplicas}`,
          )
          .join('\n');
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error executing ${name}: ${message}`;
  }
}
