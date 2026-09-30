'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Play, BookOpen } from 'lucide-react';
import { request } from '@/lib/api';
import { useProject, useProjectId } from '@/lib/hooks';
import { Card, ErrorBox, PageHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { CopyField } from '@/components/ui/CopyField';

const EXAMPLE = `# Tables of the project schema are queryable collections (docs/graphql.md)
query {
  __schema { queryType { fields { name } } }
}`;
const INTROSPECT = '{ __schema { queryType { fields { name description } } mutationType { fields { name } } } }';

/** GraphQL explorer: runs as the signed-in dashboard user (service role for the project). */
export default function GraphqlPage() {
  const id = useProjectId();
  const { data: project } = useProject(id);
  const [query, setQuery] = useState(EXAMPLE);
  const [variables, setVariables] = useState('{}');
  const [result, setResult] = useState<string>('');
  const run = useMutation({
    mutationFn: async (q: string) => {
      let vars = {};
      try { vars = JSON.parse(variables || '{}'); } catch { throw new Error('Variables must be JSON'); }
      return request(`/graphql/v1/${id}`, { method: 'POST', json: { query: q, variables: vars } });
    },
    onSuccess: (r) => setResult(JSON.stringify(r, null, 2)),
  });
  const endpoint = project?.endpoints?.rest_url ? project.endpoints.rest_url.replace('/rest/v1/', '/graphql/v1/') : `/graphql/v1/${id}`;
  return (
    <div className="space-y-4">
      <PageHeader title="GraphQL" description="Query and change the project's tables with GraphQL. Requests here run with service-role rights; apps use their API key and a user's token, so RLS applies." />
      <CopyField label="Endpoint" value={endpoint} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Query" actions={<div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => run.mutate(INTROSPECT)}><BookOpen className="mr-1 h-3.5 w-3.5" />Schema</Button>
          <Button size="sm" onClick={() => run.mutate(query)} loading={run.isPending} data-testid="graphql-run"><Play className="mr-1 h-3.5 w-3.5" />Run</Button>
        </div>}>
          <CodeEditor value={query} onChange={setQuery} height="320px" language="javascript" onRun={() => run.mutate(query)} />
          <label className="mt-3 block text-xs font-medium text-gray-700" htmlFor="gql-vars">Variables (JSON)</label>
          <textarea id="gql-vars" rows={4} className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs" value={variables} onChange={(e) => setVariables(e.target.value)} />
        </Card>
        <Card title="Result">
          <ErrorBox error={run.error} />
          <pre className="max-h-[480px] overflow-auto rounded bg-gray-50 p-3 text-xs" data-testid="graphql-result">{result || 'Run a query to see the result.'}</pre>
        </Card>
      </div>
    </div>
  );
}
