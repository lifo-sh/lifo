import { useEffect, useState } from 'react';
import { examples } from '@/examples/registry';

/**
 * Keep-alive host: mounts each example the first time it becomes active and
 * keeps it mounted thereafter, toggling visibility with `display`. Inactive
 * examples stay in the DOM so their kernels/terminals/VFS persist across tab
 * switches — matching the old lazy-boot behavior. Because a panel is only
 * mounted once it's active (visible), the terminal's first fit() measures a
 * real box.
 */
export function ExampleHost({ activeId }: { activeId: string }) {
  const [activated, setActivated] = useState<Set<string>>(() => new Set([activeId]));

  useEffect(() => {
    setActivated((prev) => (prev.has(activeId) ? prev : new Set(prev).add(activeId)));
  }, [activeId]);

  return (
    <div className="relative flex-1 min-h-0">
      {examples
        .filter((e) => activated.has(e.id))
        .map((e) => {
          const Component = e.Component;
          return (
            <div
              key={e.id}
              className="absolute inset-0 flex flex-col min-h-0"
              style={{ display: e.id === activeId ? 'flex' : 'none' }}
            >
              <Component />
            </div>
          );
        })}
    </div>
  );
}
