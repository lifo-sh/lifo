import { DocsView } from '@/components/docs-view';
import { DOC_LIFO_PKG } from '@/data/docs';

export default function LifoPkgExample() {
  return <DocsView title="Lifo Package Manager" html={DOC_LIFO_PKG} />;
}
