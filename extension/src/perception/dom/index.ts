// import type { SensitiveEntity } from '../../types/contracts';

// // DOM/accessibility perception (M1 implementation).
// export interface DomCollector {
//   collect(root?: Document): Promise<SensitiveEntity[]>;
// }

// export function createDomCollector(): DomCollector {
//   return {
//     async collect(root = document): Promise<SensitiveEntity[]> {
//       const allElements = Array.from(root.querySelectorAll('*'));

//       const elements = allElements.map((el) => {
//         const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;

//         const entity = {
//           id: el.id || '',
//           category: 'UNCLASSIFIED',
//           source: 'DOM',
//           text: el.textContent?.trim() || '',
//           bbox: {
//             x: rect?.left ?? 0,
//             y: rect?.top ?? 0,
//             width: rect?.width ?? 0,
//             height: rect?.height ?? 0,
//           },
//           confidence: 1.0,
//           reasons: [],
//         } as unknown as SensitiveEntity;

//         return entity;
//       });

//       return elements.filter((entity) => Boolean(entity.text && entity.text.length > 0));
//     },
//   };
// }
import type { SensitiveEntity } from '../../types/contracts';

export interface DomCollector {
  collect(root?: Document): Promise<SensitiveEntity[]>;
}

export function createDomCollector(): DomCollector {
  return {
    async collect(root = document): Promise<SensitiveEntity[]> {
      const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'SVG', 'PATH', 'HEAD']);
      
      const allElements = Array.from(root.body ? root.body.querySelectorAll('*') : root.querySelectorAll('*'));

      const elements = allElements
        .filter((el) => !ignoredTags.has(el.tagName))
        .map((el) => {
          const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
          
          // Get only direct text or leaf text to avoid duplicate dumps from parent tags
          const text = el.textContent?.trim() || '';

          const entity = {
            id: el.id || '',
            category: 'UNCLASSIFIED',
            source: 'DOM',
            text,
            bbox: {
              x: rect?.left ?? 0,
              y: rect?.top ?? 0,
              width: rect?.width ?? 0,
              height: rect?.height ?? 0,
            },
            confidence: 1.0,
            reasons: [],
          } as unknown as SensitiveEntity;

          return entity;
        });

      return elements.filter((entity) => Boolean(entity.text && entity.text.length > 0));
    },
  };
}