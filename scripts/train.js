// Reproducible small genetic optimizer. Does not overwrite the deployed policy.
import { mkdir, writeFile } from 'node:fs/promises';
import { seededRandom } from '../src/engine.js';
import { runSession } from '../ai/evaluation.js';
import { DEFAULT_WEIGHTS } from '../ai/search.js';

const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const population = Number(arg('population', 8));
const generations = Number(arg('generations', 4));
const maxPieces = Number(arg('max-pieces', 1500));
const games = Number(arg('games', 3));
if (![population, generations, maxPieces, games].every(Number.isInteger) || population < 4 || population > 100 || generations < 1 || generations > 100 || maxPieces < 1 || games < 1 || games > 50) throw new Error('Invalid training configuration');
const random = seededRandom(Number(arg('seed', 2026)));
const keys = Object.keys(DEFAULT_WEIGHTS);
const mutate = weights => Object.fromEntries(keys.map(key => [key, weights[key] * Math.exp((random() - .5) * .8)]));
let candidates = [DEFAULT_WEIGHTS, ...Array.from({ length: population - 1 }, () => mutate(DEFAULT_WEIGHTS))];
const history = [];
for (let generation = 0; generation < generations; generation++) {
  const scores = [];
  for (const weights of candidates) {
    const records = [];
    for (let index = 0; index < games; index++) records.push(await runSession(100 + index, { maxPieces, options: { depth: 1, beam: 8, weights } }));
    const fitness = records.reduce((sum, record) => sum + record.lines, 0) / games;
    scores.push({ weights, fitness, records });
  }
  scores.sort((a, b) => b.fitness - a.fitness);
  history.push({ generation, best: scores[0], meanFitness: scores.reduce((sum, item) => sum + item.fitness, 0) / population });
  console.log(`Generation ${generation}: best=${scores[0].fitness.toFixed(1)} lines`);
  const elites = scores.slice(0, Math.max(2, Math.floor(population / 4)));
  candidates = elites.map(item => item.weights);
  while (candidates.length < population) {
    const a = elites[Math.floor(random() * elites.length)].weights;
    const b = elites[Math.floor(random() * elites.length)].weights;
    candidates.push(mutate(Object.fromEntries(keys.map(key => [key, random() < .5 ? a[key] : b[key]]))));
  }
}
await mkdir('results', { recursive: true });
await writeFile('results/training.json', JSON.stringify({ seed: Number(arg('seed', 2026)), trainingSeeds: Array.from({ length: games }, (_, index) => 100 + index), population, generations, maxPieces, depth: 1, weights: history.at(-1).best.weights, history, note: 'Development seeds only. Do not select weights using the final test seeds.' }, null, 2) + '\n');
