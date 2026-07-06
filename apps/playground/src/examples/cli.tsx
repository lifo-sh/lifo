import { DocsView } from '@/components/docs-view';
import { DOC_CLI } from '@/data/docs';

export default function CliExample() {
  return <DocsView title="CLI (Node.js)" html={DOC_CLI} />;
}
