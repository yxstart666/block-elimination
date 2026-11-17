/** Deterministic offline campaign authoring. Runtime reads these definitions
 * and runs its separate, bounded current-tray supply planner and hints.
 * Candidate definitions replace LEVELS inside this Node process, never on disk.
 * --verify independently replays witnesses and checks the real runtime supply.
 * --sample N authors N candidates without writing production data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS } from '../src/core/levels.ts';
import { createLevel, findHint, getLevelGoals, getLevelStage, getLevelTimeBonus, placePiece } from '../src/core/game.ts';
import { COLOR_COUNT, COLOR_NAMES } from '../src/core/colors.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'src/core/levels.ts');
const difficulties = [4,5,5,4,5,6,4,5,6,4,6,6,5,7,6,6,5,8,6,6,5,6,6,5,7,6,6,5,8,6];
const order = ['lines','lines','lines','gems','gems','lines','colors','colors','gems','dual','dual','lines','dual','dual','colors','dual','gems','dual','colors','dual','lines','dual','gems','dual','dual','colors','dual','lines','dual','dual'];
// Conservative leaderboard validation estimates, independent of live play.
const scoreMoveEstimates = {4:300,5:360,6:420,7:540,8:660};
const names = {
  lines:['初识消除','交错成行','双线回响','留白成路','星河横渡','方寸布局','十线突围','回环之境','轻舟过隙'],
  gems:['初拾星光','寻找星星','星光小径','繁星花园','星光围城','微星旅途','星河之间','星光涟漪'],
  colors:['初识颜色','蓝色回响','双色转角','彩虹留白','交织色彩','暖色小径','缤纷旅途'],
  dual:['星色相映','星彩交响','星河成行','双色星途','星色漫游','三重交响','星光与色彩','彩线回响','星色花园','星线协奏','星光成行','星彩双收','绚彩终章'],
};
const subtitles = {lines:'消线挑战',gems:'星星收集',colors:'颜色目标',dual:'组合目标'};
const colorNames = COLOR_NAMES;
const copy = value => structuredClone(value);
const key = cell => cell.y * 8 + cell.x;
const occupied = board => board.flat().filter(Boolean).length;
function random(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let n = Math.imul(seed ^ seed >>> 15, seed | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}
function fit(board, piece, x, y) {
  return piece.cells.every(p => x+p.x >= 0 && y+p.y >= 0 && x+p.x < 8 && y+p.y < 8 && !board[y+p.y][x+p.x]);
}
function placements(board, pieces) {
  const moves = [];
  pieces.forEach((piece,index) => {
    if (!piece) return;
    const width=Math.max(...piece.cells.map(p=>p.x))+1, height=Math.max(...piece.cells.map(p=>p.y))+1;
    for (let y=0;y<=8-height;y++) for (let x=0;x<=8-width;x++) if(fit(board,piece,x,y)) moves.push({index,x,y});
  });
  return moves;
}
/** Deliberately independent of core.resolveBoard and its progress counters. */
function resolve(source,piece,x,y) {
  const board=source.map(row=>row.slice());
  for(const p of piece.cells) board[y+p.y][x+p.x]=(piece.color??0)+1;
  const rows=[],columns=[];
  for(let n=0;n<8;n++) {
    if(board[n].every(Boolean)) rows.push(n);
    if(board.every(row=>row[n])) columns.push(n);
  }
  const cleared=[],colors=Array(COLOR_COUNT).fill(0);
  for(let y=0;y<8;y++) for(let x=0;x<8;x++) if(rows.includes(y)||columns.includes(x)) {
    cleared.push({x,y});colors[board[y][x]-1]++;board[y][x]=0;
  }
  return {board,cleared,colors,lines:rows.length+columns.length};
}
function fraction(state) {
  const goals=getLevelGoals(state);
  return goals.reduce((sum,g)=>sum+Math.min(1,g.current/g.target),0)/goals.length;
}
function initialBoard(seed,index,goals) {
  const rng=random(seed),board=Array.from({length:8},()=>Array(8).fill(0));
  const a=1+index%3,b=4+Math.floor(index/3)%3;
  const gapA=index%2 ? 0 : 6,gapB=Math.floor(index/2)%2 ? 0 : 6;
  const goalColors=goals.filter(g=>g.kind==='color').map(g=>g.color);
  const color=()=>rng()<.38&&goalColors.length ? goalColors[Math.floor(rng()*goalColors.length)]+1 : 1+Math.floor(rng()*COLOR_COUNT);
  for(const [row,gap] of [[a,gapA],[b,gapB]]) for(let x=0;x<8;x++) if(x<gap||x>gap+1) board[row][x]=color();
  // Four loose, edge-connected blocks leave most of the board available.
  const top=2*(index%4),bottom=6-2*(Math.floor(index/4)%4);
  const extras=[{x:top,y:0},{x:top+1,y:0},{x:bottom,y:7},{x:bottom+1,y:7}];
  for(const p of extras)board[p.y][p.x]=color();
  const transform=p=>{
    let {x,y}=p;
    if(index%2)x=7-x;
    if(Math.floor(index/2)%2)y=7-y;
    if(Math.floor(index/4)%2)[x,y]=[y,x];
    return {x,y};
  };
  const transformed=Array.from({length:8},()=>Array(8).fill(0));
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){const p=transform({x,y});transformed[p.y][p.x]=board[y][x];}
  const hasStars=goals.some(g=>g.kind==='gems');
  const gems=hasStars?[transform({x:gapA===0?3:2,y:a}),transform({x:gapB===0?5:4,y:b})]:[];
  return {board:transformed,gems};
}
function targets(index,difficulty,mechanic) {
  const primary=(index*3+2)%COLOR_COUNT,secondary=(primary+3)%COLOR_COUNT;
  if(mechanic==='lines')return[{kind:'lines',target:({4:10,5:15,6:19,7:23,8:26})[difficulty]}];
  if(mechanic==='gems')return[{kind:'gems',target:({4:9,5:14,6:18,7:22,8:26})[difficulty]}];
  if(mechanic==='colors')return difficulty<=5?
    // Five palette families occur more often than the former seven. Keep the
    // color-learning and late single-color level long enough for a full arc.
    [{kind:'color',color:primary,target:difficulty===4?40:index===27?50:45}]:
    [{kind:'color',color:primary,target:difficulty===7?58:44},{kind:'color',color:secondary,target:difficulty===7?58:44}];
  if(index===12)return[{kind:'lines',target:13},{kind:'gems',target:12}];
  if(index===17)return[{kind:'lines',target:24},{kind:'gems',target:22},{kind:'color',color:primary,target:68}];
  if(index===21)return[{kind:'lines',target:18},{kind:'color',color:primary,target:50}];
  if(index===24)return[{kind:'lines',target:22},{kind:'gems',target:20},{kind:'color',color:primary,target:60}];
  if(index===26)return[{kind:'lines',target:17},{kind:'gems',target:16}];
  return [{kind:'gems',target:({4:9,5:12,6:16,7:20,8:22})[difficulty]},
    {kind:'color',color:primary,target:({4:30,5:45,6:50,7:60,8:72})[difficulty]},
    ...(difficulty>=7?[{kind:'color',color:secondary,target:({7:54,8:65})[difficulty]}]:[])];
}
function description(goals,mechanic) {
  if(mechanic==='lines')return `累计消除 ${goals[0].target} 条行或列，横竖同时消除分别计数。`;
  const stars=goals.find(g=>g.kind==='gems'),colors=goals.filter(g=>g.kind==='color').map(g=>`${g.target} 块${colorNames[g.color]}方块`).join('和');
  if(mechanic==='gems')return `消掉星星所在的整行或整列，累计收集 ${stars.target} 颗星星；新方块也会带来星星。`;
  if(mechanic==='colors')return `填满整行或整列，累计消除 ${colors}；不要求同色相连。`;
  const parts=goals.map(goal=>goal.kind==='lines'?`消除 ${goal.target} 条行或列`:
    goal.kind==='gems'?`收集 ${goal.target} 颗星星`:`消除 ${goal.target} 块${colorNames[goal.color]}方块`);
  return `累计${parts.join('，')}，全部目标都要完成。`;
}
function subtitle(goals,mechanic) {
  if(mechanic!=='dual')return subtitles[mechanic];
  return [...new Set(goals.map(goal=>goal.kind==='lines'?'消线':goal.kind==='gems'?'星星':'颜色'))].join('＋');
}
function makeDefinition(index,seed,title) {
  const difficulty=difficulties[index],mechanic=order[index],goals=targets(index,difficulty,mechanic);
  return {id:`level-${String(index+1).padStart(2,'0')}`,number:index+1,mechanic,learning:difficulty===4,
    difficulty,title,subtitle:subtitle(goals,mechanic),description:description(goals,mechanic),
    timeLimitSeconds:null,maxMoves:scoreMoveEstimates[difficulty],starScores:[0,10,20],
    ...initialBoard(seed,index,goals),ice:[],goals,batches:[],solution:[],flow:{seed,openingBatches:4}};
}
function pieceSignature(piece) {
  return piece&&JSON.stringify([piece.id,piece.color??0,!!piece.star,piece.star?key(piece.cells[0]):null,piece.cells.map(key).sort((a,b)=>a-b)]);
}
function independentReplay(level) {
  if(level.timeLimitSeconds!==null)throw Error(`${level.id}: campaign must have no time limit or move budget`);
  let board=copy(level.board),pieces=copy(level.batches[0]),batch=0,moves=0,gems=copy(level.gems),combo=0,score=0;
  const progress={lines:0,gems:0,colors:Array(COLOR_COUNT).fill(0)};
  const current=g=>g.kind==='lines'?progress.lines:g.kind==='gems'?progress.gems:progress.colors[g.color];
  for(const move of level.solution) {
    const piece=pieces[move.index];
    if(!piece||!fit(board,piece,move.x,move.y))throw Error(`${level.id}: illegal independent move ${moves+1}`);
    if(piece.star){const p=piece.cells[0];gems.push({x:move.x+p.x,y:move.y+p.y});}
    const result=resolve(board,piece,move.x,move.y);board=result.board;pieces[move.index]=null;moves++;
    const hit=new Set(result.cleared.map(key));progress.lines+=result.lines;
    progress.gems+=gems.filter(p=>hit.has(key(p))).length;gems=gems.filter(p=>!hit.has(key(p)));
    for(let c=0;c<COLOR_COUNT;c++)progress.colors[c]+=result.colors[c];
    combo=result.lines?combo+1:0;score+=10+result.lines*20+Math.max(0,combo-1)*10;
    if(level.goals.every(g=>current(g)>=g.target)) {
      if(moves!==level.solution.length)throw Error(`${level.id}: witness did not stop at first victory`);
      if(score!==level.starScores[2])throw Error(`${level.id}: third-star score must equal real witness ${score}`);
      return {moves,score,...progress};
    }
    if(pieces.every(p=>!p))pieces=copy(level.batches[++batch]??[]);
  }
  throw Error(`${level.id}: independent witness did not win`);
}
function runtimeReplay(level,checkScore=true) {
  let state=createLevel(level.id),batch=-1;
  for(const [index,move] of level.solution.entries()) {
    if(state.batch!==batch) {
      batch=state.batch;
      if(JSON.stringify(state.pieces.map(pieceSignature))!==JSON.stringify(level.batches[batch]?.map(pieceSignature)))throw Error(`${level.id}: supply replay mismatch at batch ${batch}`);
    }
    const result=placePiece(state,move.index,move.x,move.y);
    if(!result)throw Error(`${level.id}: runtime rejected witness ${index+1}`);
    state=result.state;
    if(state.status!=='playing'&&index!==level.solution.length-1)throw Error(`${level.id}: runtime stopped early`);
  }
  if(state.status!=='won'||checkScore&&state.score!==level.starScores[2])throw Error(`${level.id}: runtime witness did not win with 3 stars`);
  if(state.level.timeRemainingMs!==undefined||getLevelTimeBonus(state)!==0)throw Error(`${level.id}: campaign witness must not include a timer or time points`);
  return state;
}
/** Count opening branches using an independent beam for the remaining tray.
 * Each counted branch uses all three pieces and clears at least one line. */
function openingBranches(level) {
  const first=placements(level.board,level.batches[0]);let viable=0;
  for(const move of first) {
    const one=resolve(level.board,level.batches[0][move.index],move.x,move.y);
    const remaining=level.batches[0].map((p,i)=>i===move.index?null:p);
    let beam=[{board:one.board,pieces:remaining,lines:one.lines}];
    for(let depth=0;depth<2;depth++) {
      const next=[];
      for(const entry of beam)for(const m of placements(entry.board,entry.pieces)) {
        const result=resolve(entry.board,entry.pieces[m.index],m.x,m.y);
        next.push({board:result.board,pieces:entry.pieces.map((p,i)=>i===m.index?null:p),lines:entry.lines+result.lines});
      }
      next.sort((a,b)=>(b.lines*100-occupied(b.board))-(a.lines*100-occupied(a.board)));
      beam=next.slice(0,5);
    }
    if(beam.some(p=>p.lines>0&&p.pieces.every(piece=>!piece)))viable++;
  }
  return {legalFirstPlacements:first.length,firstPlacementsWithFullTrayClearRoute:viable};
}
function author(level) {
  LEVELS.splice(0,LEVELS.length,level);
  let state=createLevel(level.id);const history=[];
  // Authoring stays bounded even though runtime has no time or placement cap.
  while(state.status==='playing' && state.moves<300) {
    if(!level.batches[state.batch])level.batches[state.batch]=copy(state.pieces);
    const hint=findHint(state);
    if(!hint)return null;
    const stage=getLevelStage(state),before=fraction(state),choices=placements(state.board,state.pieces).length;
    const result=placePiece(state,hint.index,hint.x,hint.y);
    if(!result)return null;
    level.solution.push({...hint});state=result.state;
    history.push({move:state.moves,stage,progress:before,lines:result.rows.length+result.columns.length,occupied:occupied(state.board),choices});
  }
  if(state.status!=='won')return null;
  // Preserve a loose offline/server score estimate, never a live move limit.
  level.maxMoves=Math.max(level.maxMoves,Math.ceil(state.moves*1.6/3)*3);
  state=runtimeReplay(level,false);
  level.starScores=[0,Math.max(10,Math.round(state.score*.7/10)*10),state.score];
  independentReplay(level);runtimeReplay(level);
  const firstClear=history.find(h=>h.lines)?.move??null;
  const thirds=Array.from({length:3},(_,part)=>{
    const entries=history.slice(Math.floor(history.length*part/3),Math.floor(history.length*(part+1)/3));
    return {moves:entries.length,lines:entries.reduce((s,h)=>s+h.lines,0),meanOccupied:+(entries.reduce((s,h)=>s+h.occupied,0)/entries.length).toFixed(1),meanChoices:+(entries.reduce((s,h)=>s+h.choices,0)/entries.length).toFixed(1)};
  });
  return {id:level.id,mechanic:level.mechanic,difficulty:level.difficulty,seed:level.flow.seed,
    occupied:occupied(level.board),moves:state.moves,score:state.score,baseScore:state.score-getLevelTimeBonus(state),timeBonus:getLevelTimeBonus(state),timeLimitSeconds:level.timeLimitSeconds,scoreMoveEstimate:level.maxMoves,
    goals:level.goals,firstClear,firstSixMovesLines:history.slice(0,6).reduce((s,h)=>s+h.lines,0),
    thirds,stages:Object.fromEntries(['opening','building','finish'].map(stage=>[stage,history.filter(h=>h.stage===stage).length])),history};
}
function encode(definitions) {
  const lines=[`import type { LevelDefinition } from './level-types.ts';`,`export type { LevelDefinition } from './level-types.ts';`,``,
    `const board = (rows: string[]) => rows.map(row => [...row].map(cell => cell === '.' ? 0 : Number(cell)));`,
    `type PieceSpec = [id: string, color: number, star: 0 | 1, coordinates: number[]];`,
    `function batches(groups: PieceSpec[][]): LevelDefinition['batches'] {`,
    `  return groups.map(group => group.map(([id, color, star, coordinates]) => ({`,
    `    id, color, ...(star ? { star: true } : {}),`,
    `    cells: coordinates.map(value => ({ x: value % 8, y: Math.floor(value / 8) })),`,
    `  })));`,`}`,``,
    `/** Seeded campaign supply follows the current board and goal progress.`,
    ` * Offline batches and solutions are verified, no-prop three-star examples;`,
    ` * runtime hints never read these witnesses. Difficulty is a design tier. */`,
    `export const LEVELS: readonly LevelDefinition[] = [`];
  for(const level of definitions) {
    lines.push(`  {`,`    id: '${level.id}', number: ${level.number}, mechanic: '${level.mechanic}', learning: ${level.learning},`,
      `    title: '${level.title}', subtitle: '${level.subtitle}', difficulty: ${level.difficulty},`,
      `    description: '${level.description}', timeLimitSeconds: ${level.timeLimitSeconds}, maxMoves: ${level.maxMoves},`,
      `    flow: ${JSON.stringify(level.flow)}, starScores: ${JSON.stringify(level.starScores)},`,`    board: board([`);
    for(const row of level.board)lines.push(`      '${row.map(c=>c||'.').join('')}',`);
    lines.push(`    ]),`,`    gems: ${JSON.stringify(level.gems)}, ice: [],`,`    goals: ${JSON.stringify(level.goals)},`,`    batches: batches([`);
    for(const group of level.batches)lines.push(`      ${JSON.stringify(group.map(p=>[p.id,p.color??0,p.star?1:0,p.cells.map(key)]))},`);
    lines.push(`    ]),`,`    solution: ${JSON.stringify(level.solution)},`,`  },`);
  }
  lines.push(`];`,``);return lines.join('\n');
}

if(process.argv.includes('--verify')) {
  for(const level of LEVELS){const stats=independentReplay(level);runtimeReplay(level);console.log(JSON.stringify({id:level.id,difficulty:level.difficulty,...stats}));}
} else {
  const sampleIndex=process.argv.indexOf('--sample'),limit=sampleIndex>=0?Number(process.argv[sampleIndex+1]??1):30;
  const definitions=[],metrics=[],counts={lines:0,gems:0,colors:0,dual:0},signatures=new Set();
  for(let index=0;index<limit;index++) {
    const title=names[order[index]][counts[order[index]]++];let accepted;
    for(let attempt=0;attempt<30;attempt++) {
      const seed=713000+index*1009+attempt*137,level=makeDefinition(index,seed,title),metric=author(level);
      if(!metric){console.error(`${level.id}: retry seed ${seed} (no-prop route failed)`);continue;}
      if(metric.firstClear>6){console.error(`${level.id}: retry seed ${seed} (first clear ${metric.firstClear})`);continue;}
      const opening=openingBranches(level);
      if(opening.firstPlacementsWithFullTrayClearRoute<12){console.error(`${level.id}: retry seed ${seed} (opening clear branches ${opening.firstPlacementsWithFullTrayClearRoute})`);continue;}
      const signature=level.board.flat().map(Boolean).map(Number).join('');
      if(signatures.has(signature))throw Error(`Repeated board ${level.id}`);
      signatures.add(signature);accepted={level,metric:{...metric,...opening}};break;
    }
    if(!accepted)throw Error(`Cannot author ${index+1}`);
    definitions.push(accepted.level);metrics.push(accepted.metric);
    const {history,...summary}=accepted.metric;console.log(JSON.stringify(summary));
  }
  const directory=path.join(root,'.local/flow-author');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,sampleIndex>=0?'sample-metrics.json':'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
  fs.writeFileSync(path.join(directory,'definitions.json'),JSON.stringify(definitions,null,2)+'\n');
  if(sampleIndex<0){fs.writeFileSync(output,encode(definitions));console.log(`Wrote ${definitions.length} verified, adaptive campaign levels.`);}
}
