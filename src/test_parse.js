const parseTokens = () => {
    let el = { getAttribute: () => "10,10 100,10 100,200 10,200" };
    const pointsStr = el.getAttribute('points') || '';
    const points = pointsStr.trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));
    console.log(points);
    if (points.length < 2) return [];
    const cmds = [{ type: 'M', args: [points[0], points[1]] }];
    for (let i = 2; i < points.length; i += 2) {
        if (i + 1 < points.length) cmds.push({ type: 'L', args: [points[i], points[i+1]] });
    }
    cmds.push({ type: 'Z', args: [] });
    return cmds;
};
console.log(parseTokens());
