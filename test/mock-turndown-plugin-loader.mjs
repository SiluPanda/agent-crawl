const stubSource = `
export const gfm = () => ({});
export default { gfm };
`;

const stubUrl = `data:text/javascript,${encodeURIComponent(stubSource)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'turndown-plugin-gfm' || specifier.startsWith('turndown-plugin-gfm/')) {
    return {
      url: stubUrl,
      shortCircuit: true,
    };
  }

  return nextResolve(specifier, context);
}
