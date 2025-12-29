import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();

// Load config from cluster (when running in K8s) or from local kubeconfig
if (process.env['KUBERNETES_SERVICE_HOST']) {
  kc.loadFromCluster();
} else {
  kc.loadFromDefault();
}

export const coreApi = kc.makeApiClient(k8s.CoreV1Api);
export const appsApi = kc.makeApiClient(k8s.AppsV1Api);
export const networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
export const autoscalingApi = kc.makeApiClient(k8s.AutoscalingV1Api);
export const batchApi = kc.makeApiClient(k8s.BatchV1Api);
export const metricsApi = kc.makeApiClient(k8s.CustomObjectsApi);

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  age: string;
  containers: { name: string; ready: boolean; restartCount: number }[];
}

export interface EventInfo {
  type: string;
  reason: string;
  message: string;
  involvedObject: string;
  count: number;
  lastTimestamp: string;
}

// Get pods in a namespace or all namespaces
export async function getPods(namespace?: string): Promise<PodInfo[]> {
  const response = namespace ? await coreApi.listNamespacedPod(namespace) : await coreApi.listPodForAllNamespaces();

  return response.body.items.map((pod) => ({
    name: pod.metadata?.name || 'unknown',
    namespace: pod.metadata?.namespace || 'unknown',
    status: pod.status?.phase || 'unknown',
    restarts: pod.status?.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) || 0,
    age: getAge(pod.metadata?.creationTimestamp),
    containers:
      pod.status?.containerStatuses?.map((c) => ({
        name: c.name,
        ready: c.ready,
        restartCount: c.restartCount,
      })) || [],
  }));
}

// Get pod details
export async function describePod(name: string, namespace: string): Promise<string> {
  const response = await coreApi.readNamespacedPod(name, namespace);
  const pod = response.body;
  const status = pod.status;
  const spec = pod.spec;

  let description = `Pod: ${name}\nNamespace: ${namespace}\n`;
  description += `Status: ${status?.phase}\n`;
  description += `Node: ${spec?.nodeName}\n\n`;

  // Container info
  description += '=== Containers ===\n';
  for (const container of spec?.containers || []) {
    description += `\n${container.name}:\n`;
    description += `  Image: ${container.image}\n`;
    description += `  Resources:\n`;
    description += `    Requests: CPU=${container.resources?.requests?.['cpu'] || 'none'}, Memory=${container.resources?.requests?.['memory'] || 'none'}\n`;
    description += `    Limits: CPU=${container.resources?.limits?.['cpu'] || 'none'}, Memory=${container.resources?.limits?.['memory'] || 'none'}\n`;
  }

  // Container statuses
  description += '\n=== Container Statuses ===\n';
  for (const cs of status?.containerStatuses || []) {
    description += `\n${cs.name}:\n`;
    description += `  Ready: ${cs.ready}\n`;
    description += `  Restarts: ${cs.restartCount}\n`;
    if (cs.state?.waiting) {
      description += `  State: Waiting (${cs.state.waiting.reason})\n`;
      description += `  Message: ${cs.state.waiting.message || 'none'}\n`;
    }
    if (cs.state?.terminated) {
      description += `  State: Terminated (${cs.state.terminated.reason})\n`;
      description += `  Exit Code: ${cs.state.terminated.exitCode}\n`;
    }
    if (cs.lastState?.terminated) {
      description += `  Last State: Terminated (${cs.lastState.terminated.reason})\n`;
      description += `  Last Exit Code: ${cs.lastState.terminated.exitCode}\n`;
    }
  }

  return description;
}

// Get pod logs
export async function getPodLogs(
  name: string,
  namespace: string,
  tailLines = 100,
  container?: string,
): Promise<string> {
  const response = await coreApi.readNamespacedPodLog(
    name,
    namespace,
    container,
    undefined, // follow
    undefined, // insecureSkipTLSVerifyBackend
    undefined, // limitBytes
    undefined, // pretty
    false, // previous
    undefined, // sinceSeconds
    tailLines,
  );
  return response.body || 'No logs available';
}

// Get previous pod logs (useful for crash analysis)
export async function getPreviousPodLogs(
  name: string,
  namespace: string,
  tailLines = 100,
  container?: string,
): Promise<string> {
  try {
    const response = await coreApi.readNamespacedPodLog(
      name,
      namespace,
      container,
      undefined, // follow
      undefined, // insecureSkipTLSVerifyBackend
      undefined, // limitBytes
      undefined, // pretty
      true, // previous
      undefined, // sinceSeconds
      tailLines,
    );
    return response.body || 'No previous logs available';
  } catch {
    return 'No previous logs available (pod may not have crashed)';
  }
}

// Get events
export async function getEvents(namespace?: string): Promise<EventInfo[]> {
  const response = namespace ? await coreApi.listNamespacedEvent(namespace) : await coreApi.listEventForAllNamespaces();

  return response.body.items
    .sort((a, b) => new Date(b.lastTimestamp || 0).getTime() - new Date(a.lastTimestamp || 0).getTime())
    .slice(0, 50)
    .map((event) => ({
      type: event.type || 'Normal',
      reason: event.reason || 'unknown',
      message: event.message || '',
      involvedObject: `${event.involvedObject?.kind}/${event.involvedObject?.name}`,
      count: event.count || 1,
      lastTimestamp: event.lastTimestamp?.toISOString() || 'unknown',
    }));
}

// Get deployments
export async function getDeployments(
  namespace?: string,
): Promise<{ name: string; namespace: string; replicas: string; available: number }[]> {
  const response = namespace
    ? await appsApi.listNamespacedDeployment(namespace)
    : await appsApi.listDeploymentForAllNamespaces();

  return response.body.items.map((dep) => ({
    name: dep.metadata?.name || 'unknown',
    namespace: dep.metadata?.namespace || 'unknown',
    replicas: `${dep.status?.readyReplicas || 0}/${dep.spec?.replicas || 0}`,
    available: dep.status?.availableReplicas || 0,
  }));
}

// Get pod metrics (CPU/Memory usage)
export async function getPodMetrics(
  namespace?: string,
): Promise<{ name: string; namespace: string; cpu: string; memory: string }[]> {
  try {
    const response = namespace
      ? await metricsApi.listNamespacedCustomObject('metrics.k8s.io', 'v1beta1', namespace, 'pods')
      : await metricsApi.listClusterCustomObject('metrics.k8s.io', 'v1beta1', 'pods');

    const body = response.body as {
      items: Array<{
        metadata: { name: string; namespace: string };
        containers: Array<{ usage: { cpu: string; memory: string } }>;
      }>;
    };

    return body.items.map((pod) => ({
      name: pod.metadata.name,
      namespace: pod.metadata.namespace,
      cpu: `${pod.containers.reduce((sum, c) => sum + parseCpu(c.usage.cpu), 0).toString()}m`,
      memory: `${pod.containers.reduce((sum, c) => sum + parseMemory(c.usage.memory), 0).toString()}Mi`,
    }));
  } catch {
    return [];
  }
}

// Get namespaces
export async function getNamespaces(): Promise<string[]> {
  const response = await coreApi.listNamespace();
  return response.body.items.map((ns) => ns.metadata?.name || 'unknown');
}

// Get services
export async function getServices(
  namespace?: string,
): Promise<{ name: string; namespace: string; type: string; clusterIP: string; ports: string }[]> {
  const response = namespace
    ? await coreApi.listNamespacedService(namespace)
    : await coreApi.listServiceForAllNamespaces();

  return response.body.items.map((svc) => ({
    name: svc.metadata?.name || 'unknown',
    namespace: svc.metadata?.namespace || 'unknown',
    type: svc.spec?.type || 'ClusterIP',
    clusterIP: svc.spec?.clusterIP || 'None',
    ports: svc.spec?.ports?.map((p) => `${p.port}/${p.protocol}`).join(', ') || 'none',
  }));
}

// Get configmaps
export async function getConfigMaps(
  namespace?: string,
): Promise<{ name: string; namespace: string; dataKeys: string[] }[]> {
  const response = namespace
    ? await coreApi.listNamespacedConfigMap(namespace)
    : await coreApi.listConfigMapForAllNamespaces();

  return response.body.items.map((cm) => ({
    name: cm.metadata?.name || 'unknown',
    namespace: cm.metadata?.namespace || 'unknown',
    dataKeys: Object.keys(cm.data || {}),
  }));
}

// Get configmap details
export async function describeConfigMap(name: string, namespace: string): Promise<string> {
  const response = await coreApi.readNamespacedConfigMap(name, namespace);
  const cm = response.body;

  let description = `ConfigMap: ${name}\nNamespace: ${namespace}\n\n`;
  description += '=== Data Keys ===\n';

  for (const [key, value] of Object.entries(cm.data || {})) {
    const preview = value.length > 200 ? `${value.substring(0, 200)}...` : value;
    description += `\n${key}:\n${preview}\n`;
  }

  return description;
}

// Get ingresses
export async function getIngresses(
  namespace?: string,
): Promise<{ name: string; namespace: string; hosts: string[]; paths: string }[]> {
  const response = namespace
    ? await networkingApi.listNamespacedIngress(namespace)
    : await networkingApi.listIngressForAllNamespaces();

  return response.body.items.map((ing) => ({
    name: ing.metadata?.name || 'unknown',
    namespace: ing.metadata?.namespace || 'unknown',
    hosts: ing.spec?.rules?.map((r) => r.host || '*') || [],
    paths:
      ing.spec?.rules?.flatMap((r) => r.http?.paths?.map((p) => `${r.host || '*'}${p.path}`) || []).join(', ') ||
      'none',
  }));
}

// Get HorizontalPodAutoscalers
export async function getHPAs(namespace?: string): Promise<
  {
    name: string;
    namespace: string;
    target: string;
    minReplicas: number;
    maxReplicas: number;
    currentReplicas: number;
  }[]
> {
  const response = namespace
    ? await autoscalingApi.listNamespacedHorizontalPodAutoscaler(namespace)
    : await autoscalingApi.listHorizontalPodAutoscalerForAllNamespaces();

  return response.body.items.map((hpa) => ({
    name: hpa.metadata?.name || 'unknown',
    namespace: hpa.metadata?.namespace || 'unknown',
    target: hpa.spec?.scaleTargetRef?.name || 'unknown',
    minReplicas: hpa.spec?.minReplicas || 1,
    maxReplicas: hpa.spec?.maxReplicas || 1,
    currentReplicas: hpa.status?.currentReplicas || 0,
  }));
}

// Get ReplicaSets
export async function getReplicaSets(
  namespace?: string,
): Promise<{ name: string; namespace: string; replicas: string; age: string }[]> {
  const response = namespace
    ? await appsApi.listNamespacedReplicaSet(namespace)
    : await appsApi.listReplicaSetForAllNamespaces();

  return response.body.items.map((rs) => ({
    name: rs.metadata?.name || 'unknown',
    namespace: rs.metadata?.namespace || 'unknown',
    replicas: `${rs.status?.readyReplicas || 0}/${rs.spec?.replicas || 0}`,
    age: getAge(rs.metadata?.creationTimestamp),
  }));
}

// Get StatefulSets
export async function getStatefulSets(
  namespace?: string,
): Promise<{ name: string; namespace: string; replicas: string; age: string }[]> {
  const response = namespace
    ? await appsApi.listNamespacedStatefulSet(namespace)
    : await appsApi.listStatefulSetForAllNamespaces();

  return response.body.items.map((ss) => ({
    name: ss.metadata?.name || 'unknown',
    namespace: ss.metadata?.namespace || 'unknown',
    replicas: `${ss.status?.readyReplicas || 0}/${ss.spec?.replicas || 0}`,
    age: getAge(ss.metadata?.creationTimestamp),
  }));
}

// Get DaemonSets
export async function getDaemonSets(
  namespace?: string,
): Promise<{ name: string; namespace: string; desired: number; ready: number; age: string }[]> {
  const response = namespace
    ? await appsApi.listNamespacedDaemonSet(namespace)
    : await appsApi.listDaemonSetForAllNamespaces();

  return response.body.items.map((ds) => ({
    name: ds.metadata?.name || 'unknown',
    namespace: ds.metadata?.namespace || 'unknown',
    desired: ds.status?.desiredNumberScheduled || 0,
    ready: ds.status?.numberReady || 0,
    age: getAge(ds.metadata?.creationTimestamp),
  }));
}

// Get Jobs
export async function getJobs(
  namespace?: string,
): Promise<{ name: string; namespace: string; completions: string; status: string; age: string }[]> {
  const response = namespace ? await batchApi.listNamespacedJob(namespace) : await batchApi.listJobForAllNamespaces();

  return response.body.items.map((job) => ({
    name: job.metadata?.name || 'unknown',
    namespace: job.metadata?.namespace || 'unknown',
    completions: `${job.status?.succeeded || 0}/${job.spec?.completions || 1}`,
    status: job.status?.conditions?.[0]?.type || (job.status?.active ? 'Running' : 'Unknown'),
    age: getAge(job.metadata?.creationTimestamp),
  }));
}

// Get CronJobs
export async function getCronJobs(
  namespace?: string,
): Promise<{ name: string; namespace: string; schedule: string; lastSchedule: string; active: number }[]> {
  const response = namespace
    ? await batchApi.listNamespacedCronJob(namespace)
    : await batchApi.listCronJobForAllNamespaces();

  return response.body.items.map((cj) => ({
    name: cj.metadata?.name || 'unknown',
    namespace: cj.metadata?.namespace || 'unknown',
    schedule: cj.spec?.schedule || 'unknown',
    lastSchedule: cj.status?.lastScheduleTime ? `${getAge(cj.status.lastScheduleTime)} ago` : 'Never',
    active: cj.status?.active?.length || 0,
  }));
}

// Get Nodes
export async function getNodes(): Promise<
  { name: string; status: string; roles: string; age: string; version: string }[]
> {
  const response = await coreApi.listNode();

  return response.body.items.map((node) => {
    const conditions = node.status?.conditions || [];
    const readyCondition = conditions.find((c) => c.type === 'Ready');
    const status = readyCondition?.status === 'True' ? 'Ready' : 'NotReady';

    const roles =
      Object.keys(node.metadata?.labels || {})
        .filter((l) => l.startsWith('node-role.kubernetes.io/'))
        .map((l) => l.replace('node-role.kubernetes.io/', ''))
        .join(',') || 'none';

    return {
      name: node.metadata?.name || 'unknown',
      status,
      roles,
      age: getAge(node.metadata?.creationTimestamp),
      version: node.status?.nodeInfo?.kubeletVersion || 'unknown',
    };
  });
}

// Get PersistentVolumeClaims
export async function getPVCs(
  namespace?: string,
): Promise<
  { name: string; namespace: string; status: string; volume: string; capacity: string; storageClass: string }[]
> {
  const response = namespace
    ? await coreApi.listNamespacedPersistentVolumeClaim(namespace)
    : await coreApi.listPersistentVolumeClaimForAllNamespaces();

  return response.body.items.map((pvc) => ({
    name: pvc.metadata?.name || 'unknown',
    namespace: pvc.metadata?.namespace || 'unknown',
    status: pvc.status?.phase || 'unknown',
    volume: pvc.spec?.volumeName || 'none',
    capacity: pvc.status?.capacity?.['storage'] || 'unknown',
    storageClass: pvc.spec?.storageClassName || 'default',
  }));
}

// Get Endpoints
export async function getEndpoints(
  namespace?: string,
): Promise<{ name: string; namespace: string; endpoints: string }[]> {
  const response = namespace
    ? await coreApi.listNamespacedEndpoints(namespace)
    : await coreApi.listEndpointsForAllNamespaces();

  return response.body.items.map((ep) => {
    const addresses = ep.subsets?.flatMap((s) => s.addresses?.map((a) => a.ip) || []) || [];
    return {
      name: ep.metadata?.name || 'unknown',
      namespace: ep.metadata?.namespace || 'unknown',
      endpoints: addresses.length > 0 ? addresses.slice(0, 5).join(', ') + (addresses.length > 5 ? '...' : '') : 'none',
    };
  });
}

// Get Secrets (names only, no data for security)
export async function getSecrets(
  namespace?: string,
): Promise<{ name: string; namespace: string; type: string; dataKeys: number }[]> {
  const response = namespace
    ? await coreApi.listNamespacedSecret(namespace)
    : await coreApi.listSecretForAllNamespaces();

  return response.body.items.map((secret) => ({
    name: secret.metadata?.name || 'unknown',
    namespace: secret.metadata?.namespace || 'unknown',
    type: secret.type || 'Opaque',
    dataKeys: Object.keys(secret.data || {}).length,
  }));
}

// Get Rollout Status
export async function getRolloutStatus(name: string, namespace: string): Promise<string> {
  const response = await appsApi.readNamespacedDeployment(name, namespace);
  const dep = response.body;
  const status = dep.status;

  let result = `Deployment: ${name}\n`;
  result += `Namespace: ${namespace}\n`;
  result += `Replicas: ${status?.readyReplicas || 0}/${dep.spec?.replicas || 0} ready\n`;
  result += `Updated: ${status?.updatedReplicas || 0}\n`;
  result += `Available: ${status?.availableReplicas || 0}\n`;

  const conditions = status?.conditions || [];
  result += '\nConditions:\n';
  for (const c of conditions) {
    result += `  ${c.type}: ${c.status} - ${c.message || ''}\n`;
  }

  return result;
}

// Get Rollout History
export async function getRolloutHistory(name: string, namespace: string): Promise<string> {
  const response = await appsApi.listNamespacedReplicaSet(namespace);
  const replicaSets = response.body.items
    .filter((rs) => rs.metadata?.ownerReferences?.some((o) => o.name === name))
    .sort((a, b) => {
      const revA = Number.parseInt(a.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0', 10);
      const revB = Number.parseInt(b.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '0', 10);
      return revB - revA;
    });

  if (replicaSets.length === 0) {
    return `No revision history found for deployment ${name}`;
  }

  let result = `Rollout History for ${name}:\n\n`;
  for (const rs of replicaSets.slice(0, 10)) {
    const revision = rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || '?';
    const image = rs.spec?.template?.spec?.containers?.[0]?.image || 'unknown';
    const age = getAge(rs.metadata?.creationTimestamp);
    result += `Revision ${revision}: ${image.split('/').pop()} (${age} ago)\n`;
  }

  return result;
}

// ============================================
// WRITE OPERATIONS (require confirmation in UI)
// ============================================

// Delete a pod
export async function deletePod(name: string, namespace: string): Promise<string> {
  await coreApi.deleteNamespacedPod(name, namespace);
  return `Pod ${name} deleted from ${namespace}`;
}

// Delete a deployment
export async function deleteDeployment(name: string, namespace: string): Promise<string> {
  await appsApi.deleteNamespacedDeployment(name, namespace);
  return `Deployment ${name} deleted from ${namespace}`;
}

// Delete a service
export async function deleteService(name: string, namespace: string): Promise<string> {
  await coreApi.deleteNamespacedService(name, namespace);
  return `Service ${name} deleted from ${namespace}`;
}

// Delete a configmap
export async function deleteConfigMap(name: string, namespace: string): Promise<string> {
  await coreApi.deleteNamespacedConfigMap(name, namespace);
  return `ConfigMap ${name} deleted from ${namespace}`;
}

// Delete a job
export async function deleteJob(name: string, namespace: string): Promise<string> {
  await batchApi.deleteNamespacedJob(name, namespace, undefined, undefined, undefined, undefined, 'Background');
  return `Job ${name} deleted from ${namespace}`;
}

// Restart a deployment (rollout restart)
export async function restartDeployment(name: string, namespace: string): Promise<string> {
  const patch = {
    spec: {
      template: {
        metadata: {
          annotations: {
            'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
          },
        },
      },
    },
  };

  await appsApi.patchNamespacedDeployment(
    name,
    namespace,
    patch,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
  );

  return `Deployment ${name} restarted in ${namespace}`;
}

// Scale a deployment
export async function scaleDeployment(name: string, namespace: string, replicas: number): Promise<string> {
  const patch = {
    spec: {
      replicas,
    },
  };

  await appsApi.patchNamespacedDeployment(
    name,
    namespace,
    patch,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
  );

  return `Deployment ${name} scaled to ${replicas} replicas in ${namespace}`;
}

// Helper functions
function getAge(timestamp: Date | undefined): string {
  if (!timestamp) return 'unknown';
  const seconds = Math.floor((Date.now() - timestamp.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function parseCpu(cpu: string): number {
  if (cpu.endsWith('n')) return Number.parseInt(cpu, 10) / 1000000;
  if (cpu.endsWith('m')) return Number.parseInt(cpu, 10);
  return Number.parseInt(cpu, 10) * 1000;
}

function parseMemory(memory: string): number {
  if (memory.endsWith('Ki')) return Number.parseInt(memory, 10) / 1024;
  if (memory.endsWith('Mi')) return Number.parseInt(memory, 10);
  if (memory.endsWith('Gi')) return Number.parseInt(memory, 10) * 1024;
  return Number.parseInt(memory, 10) / (1024 * 1024);
}
