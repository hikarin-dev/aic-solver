/* Dedicated HiGHS worker for production LPs. Model serialisation and the WASM
   solve both stay off the UI thread so pointer input is never blocked by a
   large CPLEX-LP string build. */
'use strict';

const HIGHS_BASE = 'https://cdn.jsdelivr.net/npm/highs@1.15.1/build/';
const highsPromise = (async () => {
  importScripts(HIGHS_BASE + 'highs.js');
  const loader = typeof Module === 'function' ? Module : self.Module;
  if (typeof loader !== 'function') throw new Error('HiGHS worker loader unavailable');
  return loader({ locateFile: file => HIGHS_BASE + file });
})();

function compileLP(model) {
  const objName = model.optimize;
  const opType = (model.opType || 'max').toLowerCase();
  const constraintTerms = new Map();
  Object.keys(model.constraints).forEach(name => constraintTerms.set(name, []));
  const objTerms = [];

  Object.entries(model.variables).forEach(([variableName, coefficients]) => {
    Object.entries(coefficients).forEach(([key, coefficient]) => {
      if (!Number.isFinite(coefficient) || coefficient === 0) return;
      const term = `${coefficient < 0 ? '- ' : '+ '}${Math.abs(coefficient)} ${variableName}`;
      if (key === objName) objTerms.push(term);
      else constraintTerms.get(key)?.push(term);
    });
  });

  const stripLeadingPlus = value => value.replace(/^\+\s+/, '');
  const constraintLines = [];
  Object.entries(model.constraints).forEach(([name, bound]) => {
    const terms = constraintTerms.get(name);
    if (!terms?.length) return;
    const expression = stripLeadingPlus(terms.join(' '));
    if ('max' in bound) constraintLines.push(`  ${name}: ${expression} <= ${bound.max}`);
    else if ('min' in bound) constraintLines.push(`  ${name}: ${expression} >= ${bound.min}`);
    else if ('equal' in bound) constraintLines.push(`  ${name}: ${expression} = ${bound.equal}`);
  });

  const generals = model.generals?.length
    ? `\nGeneral\n  ${model.generals.join('\n  ')}\n`
    : '';
  return `${opType === 'min' ? 'Minimize' : 'Maximize'}\n  obj: ${objTerms.length ? stripLeadingPlus(objTerms.join(' ')) : '0'}\nSubject To\n${constraintLines.join('\n')}${generals}\nEnd\n`;
}

self.onmessage = async event => {
  const { id, model, lp, options } = event.data || {};
  try {
    const highs = await highsPromise;
    const compileStarted = performance.now();
    const lpText = lp || compileLP(model);
    const compileMs = performance.now() - compileStarted;
    const solveStarted = performance.now();
    const solveOptions = options || model?.options || null;
    const solution = solveOptions ? highs.solve(lpText, solveOptions) : highs.solve(lpText);
    self.postMessage({
      id,
      solution,
      compileMs,
      solveMs: performance.now() - solveStarted,
      lpBytes: lpText.length,
    });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
