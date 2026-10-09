//! 长截图拼接：用户在选区内上下滚动，逐帧找出与上一帧的滚动距离，把新出现的内容接到长图的顶部或底部。
//!
//! - 直接比对像素亮度（每行等距取若干列）：差异超过 [`DIFF`] 的像素才算“对不上”，固定水印、悬停底色、
//!   抗锯齿这类浅色差异不影响判断；只有文字、图形错位这种明显差异才算。
//! - 只比对两帧之间有变化的列：不随内容滚动的侧栏、留白不参与，避免它们把结果拉向“没有滚动”。
//! - “对不上”按占重叠部分内容的比例计算：稀疏文字页也能区分对错；重叠部分全是空白、无法判断时宁可提示接不上，
//!   也不瞎拼。两帧同一位置都没变的内容（浮动工具栏、固定按钮、水印笔画）不参与比较。
//! - 先在缩小的画面上粗找几个候选距离，再在原分辨率逐像素确认，取对不上比例最小者，并要求明显好于其他位置。
//! - 计算时排除右侧滚动条区域（滚动时会浮现并移动）。
//! - 第一次检测到滚动时，找出顶部、底部两帧都不变、且有清晰内容的行（固定导航栏、底栏），只保留一份，中间部分参与拼接。
//! - 两帧没有可靠重叠（滚动太快）时跳过该帧，等用户往回滚到能接上的位置。
//! 像素格式为 BGRA，每像素 4 字节；输出时转换为 RGBA 编码 PNG。
use std::{collections::VecDeque, ops::Range};

/// 拼接结果最高像素数，超过后不再追加。
pub const MAX_HEIGHT: usize = 20_000;
/// 一帧画面（BGRA，行紧密排列）。
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

impl Frame {
    fn row(&self, index: usize) -> &[u8] {
        &self.pixels[index * self.width * 4..(index + 1) * self.width * 4]
    }
}

/// 两个像素亮度差超过此值才算对不上（文字与底色的差远大于它，水印、悬停底色、抗锯齿远小于它）。
const DIFF: u8 = 40;
/// 判定“同一位置没变化”（固定顶栏、底栏）时允许的亮度差。
const SAME: u8 = 8;
/// 每行最多取样的列数。
const SAMPLE_COLUMNS: usize = 512;
/// 粗找时画面缩小到的行数、列组数上限。
const COARSE_ROWS: usize = 360;
const COARSE_GROUPS: usize = 64;
/// 粗找后在原分辨率确认的候选数。
const CANDIDATES: usize = 6;
/// 重叠部分至少要有这么多“内容”取样点，才能判断是否对上（空白处到处都能“对上”，不能作数）。
const MIN_INK: usize = 24;
/// 接受滚动距离的条件：对不上的取样点占重叠部分内容取样点的比例不超过此值，不超过“没滚动”时的一半，
/// 且明显好于其他位置的候选（见 [`UNIQUE_RATIO`]）。
const MAX_MISMATCH: f32 = 0.3;
/// 其他位置的最好候选至少是最好距离的这么多倍、且至少多出 [`UNIQUE_MARGIN`]，才认为最好距离可靠
/// （避免在相似结构间错位；两者都接近 0 时说明重叠部分内容不足以区分）。
const UNIQUE_RATIO: f32 = 1.5;
const UNIQUE_MARGIN: f32 = 0.05;

/// 每行等距取样的亮度。
struct Gray {
    columns: usize,
    data: Vec<u8>,
}

impl Gray {
    fn new(frame: &Frame, ignore_right: usize) -> Self {
        let usable = frame.width.saturating_sub(ignore_right).max(1).min(frame.width);
        let columns = usable.min(SAMPLE_COLUMNS).max(1);
        let xs: Vec<usize> = (0..columns).map(|index| ((2 * index + 1) * usable / (2 * columns)).min(usable - 1) * 4).collect();
        let mut data = Vec::with_capacity(columns * frame.height);
        for y in 0..frame.height {
            let row = frame.row(y);
            data.extend(xs.iter().map(|&x| ((u32::from(row[x + 2]) * 77 + u32::from(row[x + 1]) * 150 + u32::from(row[x]) * 29) >> 8) as u8));
        }
        Self { columns, data }
    }

    fn at(&self, y: usize, x: usize) -> u8 {
        self.data[y * self.columns + x]
    }

    /// 取出指定行段、指定列，紧密排列。
    fn pick(&self, rows: Range<usize>, columns: &[usize]) -> Vec<u8> {
        let mut out = Vec::with_capacity(rows.len() * columns.len());
        for y in rows { out.extend(columns.iter().map(|&x| self.at(y, x))); }
        out
    }
}

/// 两帧之间有变化的列：原位比较，超过 1% 的行明显不同。
fn moving_columns(previous: &Gray, current: &Gray, height: usize) -> Vec<usize> {
    let limit = (height / 100).max(1);
    (0..previous.columns).filter(|&x| (0..height).filter(|&y| previous.at(y, x).abs_diff(current.at(y, x)) > DIFF).count() > limit).collect()
}

/// 偏离整行平均亮度超过此值的取样点算“内容”（浅灰小字也能识别，渐变底色不会）。
const INK: f32 = 24.0;

/// 一行里明显偏离整行平均亮度（超过 `threshold`）的取样点数（文字、图形）。
fn ink(row: &[u8], threshold: f32) -> usize {
    let mean = row.iter().map(|&value| f32::from(value)).sum::<f32>() / row.len().max(1) as f32;
    row.iter().filter(|&&value| (f32::from(value) - mean).abs() > threshold).count()
}

/// 偏离整行平均亮度超过此值算“清晰的内容”（导航栏文字、图标），浅色水印达不到。
const STRONG_INK: f32 = 64.0;

/// 至少有两个清晰内容取样点的行；固定顶栏、底栏里须有这样的行，避免把只有水印的空白处当成固定栏。
fn strong(row: &[u8]) -> bool {
    ink(row, STRONG_INK) >= 2
}

/// 比对标准：多大差异算对不上、多大偏离算内容、重叠部分至少要有多少内容。原分辨率与缩小后的画面各用一套。
#[derive(Clone, Copy)]
struct Criteria {
    diff: u8,
    ink: f32,
    min_ink: usize,
}

const FINE: Criteria = Criteria { diff: DIFF, ink: INK, min_ink: MIN_INK };
/// 缩小后文字被平均淡化，标准相应放宽。
const COARSE: Criteria = Criteria { diff: DIFF / 2, ink: INK / 2.0, min_ink: MIN_INK / 4 };

/// 滚动距离判断结果。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Offset {
    /// 正数表示内容上移（向下滚），负数表示向上滚。
    Moved(i64),
    Unchanged,
    /// 找不到可靠重叠；附带最好候选与原位的对不上比例，写入诊断。
    Lost { best: f32, still: f32 },
}

/// 已取出比对列的一段画面。
struct Band<'a> {
    data: &'a [u8],
    width: usize,
    rows: usize,
}

impl Band<'_> {
    fn row(&self, y: usize) -> &[u8] {
        &self.data[y * self.width..(y + 1) * self.width]
    }
}

/// 两段画面逐行的内容取样点数前缀和，用来快速求任意重叠范围里的内容量。
struct Inks {
    previous: Vec<usize>,
    current: Vec<usize>,
}

impl Inks {
    fn new(previous: &Band, current: &Band, criteria: Criteria) -> Self {
        let prefix = |band: &Band| std::iter::once(0).chain((0..band.rows).scan(0, |sum, y| { *sum += ink(band.row(y), criteria.ink); Some(*sum) })).collect();
        Self { previous: prefix(previous), current: prefix(current) }
    }

    /// 重叠部分两帧内容取样点数的平均。
    fn overlap(&self, from_previous: usize, from_current: usize, rows: usize) -> usize {
        let previous = self.previous[from_previous + rows] - self.previous[from_previous];
        let current = self.current[from_current + rows] - self.current[from_current];
        (previous + current) / 2
    }
}

/// 上一帧第 i+d 行对本帧第 i 行（d 为负时反过来）时，对不上的取样点占重叠部分内容取样点的比例；
/// 重叠部分内容太少、无法判断时返回 `None`。`fixed` 标出两帧同一位置没变化的取样点（浮动工具栏、
/// 固定按钮等不随内容滚动的东西），任一方落在这些位置的取样点不参与比较。
fn mismatch(previous: &Band, current: &Band, inks: &Inks, criteria: Criteria, fixed: Option<&[bool]>, offset: i64) -> Option<f32> {
    let overlap = previous.rows - offset.unsigned_abs() as usize;
    let (from_previous, from_current) = if offset >= 0 { (offset as usize, 0) } else { (0, offset.unsigned_abs() as usize) };
    let content = inks.overlap(from_previous, from_current, overlap);
    if content < criteria.min_ink { return None }
    let mut wrong = 0usize;
    let width = previous.width;
    for index in 0..overlap {
        let (a, b) = (previous.row(from_previous + index), current.row(from_current + index));
        match fixed {
            Some(fixed) => {
                let (fixed_a, fixed_b) = (&fixed[(from_previous + index) * width..][..width], &fixed[(from_current + index) * width..][..width]);
                wrong += (0..width).filter(|&x| !fixed_a[x] && !fixed_b[x] && a[x].abs_diff(b[x]) > criteria.diff).count();
            }
            None => wrong += a.iter().zip(b).filter(|(a, b)| a.abs_diff(**b) > criteria.diff).count(),
        }
    }
    Some(wrong as f32 / content as f32)
}

/// 缩小画面：每 `rows_per` 行、每 `columns_per` 列取平均。
fn shrink(band: &Band, rows_per: usize, columns_per: usize) -> (Vec<u8>, usize, usize) {
    let (rows, groups) = (band.rows / rows_per, band.width.div_ceil(columns_per));
    let mut out = Vec::with_capacity(rows * groups);
    for y in 0..rows {
        for group in 0..groups {
            let columns = group * columns_per..((group + 1) * columns_per).min(band.width);
            let count = (columns.len() * rows_per) as u32;
            let sum: u32 = (y * rows_per..(y + 1) * rows_per).map(|row| band.row(row)[columns.clone()].iter().map(|&value| u32::from(value)).sum::<u32>()).sum();
            out.push((sum / count) as u8);
        }
    }
    (out, rows, groups)
}

/// 找出两帧中间部分的滚动距离。
fn find_offset(previous: &Gray, current: &Gray, band: Range<usize>, columns: &[usize]) -> Offset {
    if columns.is_empty() { return Offset::Unchanged }
    let length = band.len();
    let (previous_data, current_data) = (previous.pick(band.clone(), columns), current.pick(band, columns));
    let previous_band = Band { data: &previous_data, width: columns.len(), rows: length };
    let current_band = Band { data: &current_data, width: columns.len(), rows: length };
    let inks = Inks::new(&previous_band, &current_band, FINE);
    // 原位（没滚动）时对不上的比例；整段几乎没有内容时无法判断，按“变化很大”处理
    let Some(still) = mismatch(&previous_band, &current_band, &inks, FINE, None, 0) else {
        // 变化的区域几乎没有内容（空白处的细微变化），没法也没必要判断，按没有滚动处理
        return Offset::Unchanged;
    };
    // 两帧同一位置没变化、且本身是内容（不是底色）的取样点：浮动工具栏、固定按钮、水印笔画等不随内容滚动的东西
    let mut fixed = vec![false; previous_data.len()];
    for y in 0..length {
        let (a, b) = (previous_band.row(y), current_band.row(y));
        let mean = a.iter().map(|&value| f32::from(value)).sum::<f32>() / a.len().max(1) as f32;
        for x in 0..a.len() {
            fixed[y * a.len() + x] = a[x].abs_diff(b[x]) <= SAME && (f32::from(a[x]) - mean).abs() > INK;
        }
    }
    // 至少重叠八分之一
    let minimum_overlap = (length / 8).max(12);
    if length <= minimum_overlap { return if still <= MAX_MISMATCH { Offset::Unchanged } else { Offset::Lost { best: f32::INFINITY, still } } }
    let maximum = (length - minimum_overlap) as i64;

    // 粗找：缩小后同样按“对不上的内容比例”找局部最小的几个距离；内容太少无法判断的距离不参与
    let rows_per = length.div_ceil(COARSE_ROWS).max(1);
    let columns_per = columns.len().div_ceil(COARSE_GROUPS).max(1);
    let (small_previous, rows, groups) = shrink(&previous_band, rows_per, columns_per);
    let (small_current, ..) = shrink(&current_band, rows_per, columns_per);
    let small_previous = Band { data: &small_previous, width: groups, rows };
    let small_current = Band { data: &small_current, width: groups, rows };
    let small_inks = Inks::new(&small_previous, &small_current, COARSE);
    let coarse_maximum = (maximum / rows_per as i64).min(rows as i64 - 1);
    let costs: Vec<(i64, f32)> = (-coarse_maximum..=coarse_maximum).map(|offset| {
        (offset, mismatch(&small_previous, &small_current, &small_inks, COARSE, None, offset).unwrap_or(f32::INFINITY))
    }).collect();
    let mut minima: Vec<(i64, f32)> = costs.iter().enumerate().filter(|(index, (_, cost))| {
        (*index == 0 || costs[index - 1].1 >= *cost) && (index + 1 == costs.len() || costs[index + 1].1 >= *cost)
    }).map(|(_, item)| *item).filter(|(_, cost)| cost.is_finite()).collect();
    minima.sort_by(|a, b| a.1.total_cmp(&b.1));

    // 细找：在每个候选附近逐像素确认（不含原位，原位单独比较），记下各候选的最好结果
    let reach = rows_per as i64;
    let mut found: Vec<(f32, i64)> = Vec::new();
    for &(coarse, _) in minima.iter().take(CANDIDATES) {
        let center = coarse * rows_per as i64;
        let mut local: Option<(f32, i64)> = None;
        for offset in (center - reach).max(-maximum)..=(center + reach).min(maximum) {
            if offset == 0 { continue }
            let Some(cost) = mismatch(&previous_band, &current_band, &inks, FINE, Some(&fixed), offset) else { continue };
            let better = local.is_none_or(|(best_cost, best_offset)| cost < best_cost - 1e-6 || ((cost - best_cost).abs() <= 1e-6 && offset.abs() < best_offset.abs()));
            if better { local = Some((cost, offset)); }
        }
        found.extend(local);
    }
    found.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.abs().cmp(&b.1.abs())));
    let best = found.first().copied();
    // 与最好距离不相邻的其他候选中最好的一个
    let runner_up = best.and_then(|(_, offset)| found.iter().find(|(_, other)| (other - offset).abs() > 2 * reach).map(|(cost, _)| *cost));
    match best {
        Some((cost, offset)) if cost <= MAX_MISMATCH && cost <= still * 0.5 && runner_up.is_none_or(|other| other >= cost * UNIQUE_RATIO && other >= cost + UNIQUE_MARGIN) => Offset::Moved(offset),
        // 原位基本一致：只是局部变化（光标闪烁、悬停提示），不是滚动
        _ if still <= MAX_MISMATCH => Offset::Unchanged,
        best => Offset::Lost { best: best.map_or(f32::INFINITY, |(cost, _)| cost), still },
    }
}

/// 本帧处理结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Update {
    /// 第一帧。
    First,
    /// 画面没有滚动。
    Unchanged,
    /// 找到滚动距离（正数向下、负数向上），`added` 为新拼接的行数。
    Scrolled { offset: i64, added: usize },
    /// 与上一帧找不到可靠重叠，跳过该帧。
    Lost,
}

/// 处理统计，写入诊断日志。
#[derive(Debug, Default, Clone, Copy)]
pub struct Stats {
    pub frames: usize,
    pub scrolled: usize,
    pub unchanged: usize,
    pub lost: usize,
    /// 比对总耗时（微秒）。
    pub micros: u128,
    /// 最近一次接不上时，最好候选与原位的对不上像素比例。
    pub last_lost: Option<(f32, f32)>,
}

pub struct Stitcher {
    width: usize,
    /// 计算时排除的右侧像素数（滚动条）。
    ignore_right: usize,
    header: Vec<Vec<u8>>,
    footer: Vec<Vec<u8>>,
    /// 中间滚动部分的行（每行 width * 4 字节）。
    body: VecDeque<Vec<u8>>,
    /// 固定的顶部、底部行数；第一次检测到滚动前为 `None`。
    statics: Option<(usize, usize)>,
    /// 上一帧及其亮度取样。
    previous: Option<(Frame, Gray)>,
    /// 上一帧中间部分在 `body` 中的起始行。
    position: i64,
    /// 已达到最大高度，不再追加。
    pub limited: bool,
    pub stats: Stats,
}

impl Stitcher {
    /// `ignore_right`：右侧滚动条宽度（像素），不参与比对。
    pub fn new(ignore_right: usize) -> Self {
        Self { width: 0, ignore_right, header: Vec::new(), footer: Vec::new(), body: VecDeque::new(), statics: None, previous: None, position: 0, limited: false, stats: Stats::default() }
    }

    pub fn set_ignore_right(&mut self, pixels: usize) {
        self.ignore_right = pixels;
    }

    /// 当前拼接结果的高度。
    pub fn height(&self) -> usize {
        self.header.len() + self.body.len() + self.footer.len()
    }

    pub fn add(&mut self, frame: Frame) -> Update {
        let started = std::time::Instant::now();
        self.stats.frames += 1;
        let update = self.process(frame);
        match update {
            Update::Scrolled { .. } => self.stats.scrolled += 1,
            Update::Unchanged => self.stats.unchanged += 1,
            Update::Lost => self.stats.lost += 1,
            Update::First => {}
        }
        self.stats.micros += started.elapsed().as_micros();
        update
    }

    fn process(&mut self, frame: Frame) -> Update {
        let Some((previous, previous_gray)) = self.previous.take() else {
            self.width = frame.width;
            self.body = (0..frame.height).map(|index| frame.row(index).to_vec()).collect();
            self.position = 0;
            let gray = Gray::new(&frame, self.ignore_right);
            self.previous = Some((frame, gray));
            return Update::First;
        };
        if frame.width != self.width || frame.height != previous.height {
            self.previous = Some((previous, previous_gray));
            return Update::Lost;
        }
        if previous.pixels == frame.pixels {
            self.previous = Some((previous, previous_gray));
            return Update::Unchanged;
        }
        let height = frame.height;
        let gray = Gray::new(&frame, self.ignore_right);
        let columns = moving_columns(&previous_gray, &gray, height);
        // 固定的顶栏、底栏：第一次画面变化时，同位置两帧都没变化的连续行；其中须有清晰内容的行，
        // 避免同位置恰好都是空白行（或只有固定水印）被误认；整段（含其中的分隔线、留白）都算固定区域，避免分隔线被反复拼接
        let (top, bottom) = self.statics.unwrap_or_else(|| {
            let limit = height / 3;
            let same = |y: &usize| columns.iter().all(|&x| previous_gray.at(*y, x).abs_diff(gray.at(*y, x)) <= SAME);
            let has_content = |rows: &[usize]| rows.iter().any(|&y| strong(&previous_gray.data[y * previous_gray.columns..(y + 1) * previous_gray.columns]));
            let top: Vec<usize> = (0..height).take_while(same).collect();
            let bottom: Vec<usize> = (0..height).rev().take_while(same).collect();
            let fixed = |rows: Vec<usize>| if has_content(&rows) { rows.len().min(limit) } else { 0 };
            (fixed(top), fixed(bottom))
        });
        let offset = match find_offset(&previous_gray, &gray, top..height - bottom, &columns) {
            Offset::Moved(offset) => offset,
            result => {
                // 没有滚动（局部小变化）或接不上：保留上一帧，等能接上的画面
                if let Offset::Lost { best, still } = result { self.stats.last_lost = Some((best, still)); }
                self.previous = Some((previous, previous_gray));
                return if result == Offset::Unchanged { Update::Unchanged } else { Update::Lost };
            }
        };
        // 第一次确认滚动：记下固定区域，第一帧去掉它们作为中间部分
        if self.statics.is_none() {
            self.header = (0..top).map(|index| previous.row(index).to_vec()).collect();
            self.body = (top..height - bottom).map(|index| previous.row(index).to_vec()).collect();
            self.position = 0;
            self.statics = Some((top, bottom));
        }
        let band = top..height - bottom;
        let length = band.len() as i64;
        let next = self.position + offset;
        let mut added = 0;
        if next < 0 {
            // 往上滚超过已有顶部：把新出现的行接到顶部
            for index in (0..(-next) as usize).rev() {
                if self.height() >= MAX_HEIGHT { self.limited = true; break }
                self.body.push_front(frame.row(band.start + index).to_vec());
                added += 1;
            }
            self.position = 0;
        } else {
            self.position = next;
            let end = next + length;
            let have = self.body.len() as i64;
            if end > have {
                // 往下滚超过已有底部：把新出现的行接到底部
                for index in (length - (end - have)) as usize..length as usize {
                    if self.height() >= MAX_HEIGHT { self.limited = true; break }
                    self.body.push_back(frame.row(band.start + index).to_vec());
                    added += 1;
                }
            }
        }
        self.footer = (height - bottom..height).map(|index| frame.row(index).to_vec()).collect();
        self.previous = Some((frame, gray));
        Update::Scrolled { offset, added }
    }

    fn row_at(&self, index: usize) -> &[u8] {
        if index < self.header.len() { return &self.header[index] }
        let index = index - self.header.len();
        if index < self.body.len() { return &self.body[index] }
        &self.footer[index - self.body.len()]
    }

    /// 合成完整长图（BGRA）：顶部固定行 + 中间内容 + 最新一帧的底部固定行。
    pub fn compose(&self) -> Frame {
        let height = self.height();
        let mut pixels = Vec::with_capacity(height * self.width * 4);
        for index in 0..height { pixels.extend_from_slice(self.row_at(index)); }
        Frame { width: self.width, height, pixels }
    }

    /// 等比缩小到能放进 `max_width × max_height` 的缩略图（不放大），直接从拼接数据取样，不复制整张长图。
    /// 每个输出像素取 2×2 个采样点平均，缩小后的文字不至于锯齿严重。
    pub fn thumbnail(&self, max_width: usize, max_height: usize) -> Frame {
        let (source_width, source_height) = (self.width.max(1), self.height().max(1));
        let scale = (max_width as f64 / source_width as f64).min(max_height as f64 / source_height as f64).min(1.0);
        let width = ((source_width as f64 * scale).round() as usize).max(1);
        let height = ((source_height as f64 * scale).round() as usize).max(1);
        let column = |sample: usize| (sample * source_width / (width * 2)).min(source_width - 1) * 4;
        let columns: Vec<(usize, usize)> = (0..width).map(|x| (column(2 * x), column(2 * x + 1))).collect();
        let mut pixels = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            let row = |sample: usize| self.row_at((sample * source_height / (height * 2)).min(source_height - 1));
            let (top, bottom) = (row(2 * y), row(2 * y + 1));
            for &(left, right) in &columns {
                for channel in 0..4 {
                    let sum = u16::from(top[left + channel]) + u16::from(top[right + channel]) + u16::from(bottom[left + channel]) + u16::from(bottom[right + channel]);
                    pixels.push(((sum + 2) / 4) as u8);
                }
            }
        }
        Frame { width, height, pixels }
    }
}

/// 把 BGRA 图像编码为 PNG。
pub fn encode_png(frame: &Frame) -> Result<Vec<u8>, String> {
    let mut rgba = frame.pixels.clone();
    for pixel in rgba.chunks_exact_mut(4) { pixel.swap(0, 2); }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, frame.width as u32, frame.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|error| format!("长图编码失败：{error}"))?;
        writer.write_image_data(&rgba).map_err(|error| format!("长图编码失败：{error}"))?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDTH: usize = 40;

    /// 合成一份长文档：每行像文字一样有陡峭的明暗边缘，图案按行号散列、不周期重复，底色随行号变化，间隔夹一段空白行。
    fn document(height: usize) -> Vec<Vec<u8>> {
        (0..height).map(|row| {
            if row % 37 < 5 { return vec![255; WIDTH * 4] } // 空白行
            (0..WIDTH).flat_map(|x| {
                let ink = (x.wrapping_mul(73_856_093) ^ row.wrapping_mul(19_349_663)) % 97 < 30;
                let paper = 180 + (row * 7 % 61) as u8;
                if ink { [30, 30, (row % 251) as u8, 255] } else { [paper, paper, (row / 3 % 251) as u8, 255] }
            }).collect()
        }).collect()
    }

    /// 从文档第 `top` 行开始截取高 `height` 的窗口，可附加固定顶部、底部。
    fn frame(doc: &[Vec<u8>], top: usize, height: usize, header: &[Vec<u8>], footer: &[Vec<u8>]) -> Frame {
        let mut pixels = Vec::new();
        for row in header { pixels.extend_from_slice(row); }
        for row in &doc[top..top + height] { pixels.extend_from_slice(row); }
        for row in footer { pixels.extend_from_slice(row); }
        Frame { width: WIDTH, height: header.len() + height + footer.len(), pixels }
    }

    fn rows(frame: &Frame) -> Vec<Vec<u8>> {
        frame.pixels.chunks_exact(frame.width * 4).map(<[u8]>::to_vec).collect()
    }

    /// 在有纹理的行上加入 ±1 的细微差异，模拟真实页面滚动时的抗锯齿变化。
    fn jitter(mut frame: Frame, seed: usize) -> Frame {
        for (index, value) in frame.pixels.iter_mut().enumerate() {
            if index % 4 == 3 || *value == 255 { continue }
            if (index * 31 + seed * 17) % 5 == 0 { *value = value.saturating_add(1); }
        }
        frame
    }

    #[test]
    fn 向下滚动逐段拼接成完整长图() {
        let doc = document(600);
        let mut stitcher = Stitcher::new(0);
        assert_eq!(stitcher.add(frame(&doc, 0, 120, &[], &[])), Update::First);
        for top in (30..=480).step_by(30) {
            assert!(matches!(stitcher.add(frame(&doc, top, 120, &[], &[])), Update::Scrolled { offset: 30, added: 30 }), "第 {top} 行处应找到 30 行滚动");
        }
        assert_eq!(rows(&stitcher.compose()), doc[..600].to_vec());
    }

    #[test]
    fn 画面有细微差异时仍能找到滚动距离() {
        let doc = document(600);
        let mut stitcher = Stitcher::new(0);
        stitcher.add(jitter(frame(&doc, 0, 120, &[], &[]), 0));
        for (step, top) in (40..=440).step_by(40).enumerate() {
            assert!(matches!(stitcher.add(jitter(frame(&doc, top, 120, &[], &[]), step + 1)), Update::Scrolled { offset: 40, .. }), "第 {top} 行处应容忍细微差异");
        }
        assert_eq!(stitcher.height(), 560);
    }

    #[test]
    fn 从中间开始先往上滚再往下滚两端都能拼上() {
        let doc = document(600);
        let mut stitcher = Stitcher::new(0);
        stitcher.add(frame(&doc, 300, 120, &[], &[]));
        for top in [260, 220, 180, 140, 100] { assert!(matches!(stitcher.add(frame(&doc, top, 120, &[], &[])), Update::Scrolled { offset: -40, .. })); }
        // 回到已经拼过的位置不重复拼接
        assert!(matches!(stitcher.add(frame(&doc, 200, 120, &[], &[])), Update::Scrolled { offset: 100, added: 0 }));
        for top in [250, 300, 350, 400, 450] { stitcher.add(frame(&doc, top, 120, &[], &[])); }
        assert_eq!(rows(&stitcher.compose()), doc[100..570].to_vec());
    }

    #[test]
    fn 固定顶栏与底栏只保留一份() {
        let doc = document(500);
        // 顶栏、底栏为有内容的行（按横向位置变化），模拟导航栏文字
        let header: Vec<Vec<u8>> = (0..10).map(|row| (0..WIDTH).flat_map(|x| if (x + row) % 6 < 2 { [20, 20, 20, 255] } else { [240, 240, (row * 9) as u8, 255] }).collect()).collect();
        // 底栏：顶部一条纯色分隔线、几行图标、底部留白
        let footer: Vec<Vec<u8>> = (0..6).map(|row| match row {
            0 => vec![180, 180, 180, 255].repeat(WIDTH),
            5 => vec![250, 250, 250, 255].repeat(WIDTH),
            _ => (0..WIDTH).flat_map(|x| if (x * 3 + row) % 9 < 2 { [40, 40, 40, 255] } else { [235, 235, (row * 11) as u8, 255] }).collect(),
        }).collect();
        let mut stitcher = Stitcher::new(0);
        stitcher.add(frame(&doc, 0, 100, &header, &footer));
        for top in (25..=300).step_by(25) { stitcher.add(frame(&doc, top, 100, &header, &footer)); }
        let mut expected = header.clone();
        expected.extend_from_slice(&doc[..400]);
        expected.extend(footer.clone());
        assert_eq!(rows(&stitcher.compose()), expected);
    }

    #[test]
    fn 画面不变跳过且滚得太快时等待接回() {
        let doc = document(800);
        let mut stitcher = Stitcher::new(0);
        stitcher.add(frame(&doc, 0, 100, &[], &[]));
        assert_eq!(stitcher.add(frame(&doc, 0, 100, &[], &[])), Update::Unchanged);
        stitcher.add(frame(&doc, 50, 100, &[], &[]));
        assert_eq!(stitcher.add(frame(&doc, 400, 100, &[], &[])), Update::Lost, "两帧没有重叠时跳过");
        assert!(matches!(stitcher.add(frame(&doc, 120, 100, &[], &[])), Update::Scrolled { offset: 70, added: 70 }), "回到能接上的位置后继续拼接");
        assert_eq!(rows(&stitcher.compose()), doc[..220].to_vec());
        assert_eq!((stitcher.stats.frames, stitcher.stats.unchanged, stitcher.stats.lost, stitcher.stats.scrolled), (5, 1, 1, 2));
    }

    #[test]
    fn 忽略右侧滚动条的变化() {
        let doc = document(400);
        // 右侧 6 像素模拟滚动时浮现的滚动条，滑块位置随滚动变化
        let scrolled = |top: usize| {
            let mut frame = frame(&doc, top, 100, &[], &[]);
            for row in 0..frame.height {
                let thumb = (row + top / 2) % 100 < 30;
                for x in WIDTH - 6..WIDTH { for channel in 0..3 { frame.pixels[(row * WIDTH + x) * 4 + channel] = if thumb { 60 } else { 230 }; } }
            }
            frame
        };
        let mut stitcher = Stitcher::new(6);
        stitcher.add(scrolled(0));
        for top in [40, 80, 120] { assert!(matches!(stitcher.add(scrolled(top)), Update::Scrolled { offset: 40, .. }), "滚动条变化不影响判断"); }
    }

    /// 读取项目里的真实界面截图（RGB），转为 BGRA 行。
    fn real_rows(name: &str) -> Vec<Vec<u8>> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/images").join(name);
        let decoder = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        let channels = info.line_size / info.width as usize;
        buffer[..info.line_size * info.height as usize].chunks_exact(info.line_size).map(|line| {
            line.chunks_exact(channels).flat_map(|pixel| [pixel[2], pixel[1], pixel[0], 255]).collect()
        }).collect()
    }

    #[test]
    fn 真实界面截图按不规则步长上下滚动能完整拼回() {
        let mut doc = real_rows("formatter.png");
        doc.extend(real_rows("crypto.png"));
        let width = doc[0].len() / 4;
        let window = 320;
        let shot = |top: usize| {
            let mut pixels = Vec::with_capacity(window * width * 4);
            for row in &doc[top..top + window] { pixels.extend_from_slice(row); }
            Frame { width, height: window, pixels }
        };
        let mut stitcher = Stitcher::new(0);
        let mut top: i64 = 900;
        stitcher.add(shot(top as usize));
        let (mut lowest, mut highest) = (top, top);
        // 先往上滚到顶，再往下滚到底；步长有大有小，模拟手动滚动
        // 步长保证两帧重叠部分有内容（重叠部分全是空白时任何算法都判断不了滚动距离，应提示接不上）
        let steps = [-17, -60, -120, -5, -200, -90, -150, -180, -40, -38, 23, 160, 240, 7, 255, 199, 130, 211, 75, 120, 140, 120, 150, 90, 233, 170, 120, 260, 140, 180, 220, 60];
        for step in steps {
            top = (top + step).clamp(0, (doc.len() - window) as i64);
            let update = stitcher.add(shot(top as usize));
            assert!(!matches!(update, Update::Lost), "滚动到第 {top} 行（步长 {step}）时接不上：{:?}", stitcher.stats.last_lost);
            lowest = lowest.min(top);
            highest = highest.max(top);
        }
        let result = stitcher.compose();
        assert_eq!(result.height, (highest - lowest) as usize + window, "拼接高度应等于滚动覆盖的范围");
        assert!(rows(&result) == doc[lowest as usize..highest as usize + window].to_vec(), "拼接内容应与原图一致");
    }

    #[test]
    fn 固定水印悬停底色浮动工具栏和不滚动的侧栏不影响拼接() {
        let mut doc = real_rows("formatter.png");
        doc.extend(real_rows("crypto.png"));
        let width = doc[0].len() / 4;
        let window = 320;
        let sidebar = 60;
        // 每帧都在屏幕同一位置：左侧侧栏不随内容滚动；浅色斜向水印；第 120~180 行悬停底色；第 200~220 行浮动工具栏
        let shot = |top: usize| {
            let mut pixels = Vec::with_capacity(window * width * 4);
            for (y, row) in doc[top..top + window].iter().enumerate() {
                for x in 0..width {
                    let source = if x < sidebar { &doc[y][x * 4..x * 4 + 4] } else { &row[x * 4..x * 4 + 4] };
                    let mut pixel = [source[0], source[1], source[2], 255];
                    let shade = if (x + y) / 3 % 40 < 2 && (x / 60 + y / 60) % 3 == 0 { 28 } else { 0 }
                        + if (120..180).contains(&y) && x >= sidebar { 10 } else { 0 };
                    for channel in &mut pixel[..3] { *channel = channel.saturating_sub(shade); }
                    if (200..220).contains(&y) && (400..500).contains(&x) { pixel = if (x / 4 + y / 3) % 3 == 0 { [40, 40, 40, 255] } else { [250, 250, 250, 255] }; }
                    pixels.extend_from_slice(&pixel);
                }
            }
            Frame { width, height: window, pixels }
        };
        let mut stitcher = Stitcher::new(0);
        let mut top: i64 = 0;
        stitcher.add(shot(0));
        // 模拟每 80 毫秒截一帧时的手动滚动：步长有大有小，中途停顿、往回滚
        let steps = [12, 40, 60, 3, 55, 0, 48, 60, 25, 60, 60, -30, -45, 20, 60, 60, 37, 60, 60, 52, 60, 60, 41, 60, 60, 60, 18, 60, 60, 60, 60, 60, 60];
        let mut highest = 0;
        for step in steps {
            let next = (top + step).clamp(0, (doc.len() - window) as i64);
            let update = stitcher.add(shot(next as usize));
            if next == top {
                assert_eq!(update, Update::Unchanged, "第 {next} 行没有滚动");
            } else {
                assert!(matches!(update, Update::Scrolled { offset, .. } if offset == next - top), "第 {next} 行（步长 {}）应找到准确距离，实际 {update:?}，{:?}，固定栏 {:?}", next - top, stitcher.stats.last_lost, stitcher.statics);
            }
            top = next;
            highest = highest.max(top);
        }
        assert_eq!(stitcher.height(), highest as usize + window, "拼接高度应等于滚动覆盖的范围");
    }

    #[test]
    #[ignore = "性能测量，手动运行：cargo test --release -- --ignored 测量"]
    fn 测量一帧比对耗时() {
        let mut doc = real_rows("formatter.png");
        doc.extend(real_rows("crypto.png"));
        let width = doc[0].len() / 4;
        let window = 1800;
        let shot = |top: usize| {
            let mut pixels = Vec::with_capacity(window * width * 4);
            for row in &doc[top..top + window] { pixels.extend_from_slice(row); }
            Frame { width, height: window, pixels }
        };
        let mut stitcher = Stitcher::new(0);
        stitcher.add(shot(0));
        let started = std::time::Instant::now();
        for top in [60, 140, 230, 300] { stitcher.add(shot(top)); }
        eprintln!("测量 每帧 {} 毫秒", started.elapsed().as_millis() / 4);
    }

    #[test]
    fn 达到最大高度后停止追加() {
        let doc = document(MAX_HEIGHT + 400);
        let mut stitcher = Stitcher::new(0);
        stitcher.add(frame(&doc, 0, 200, &[], &[]));
        let mut top = 0;
        while top + 300 < doc.len() { top += 100; stitcher.add(frame(&doc, top, 200, &[], &[])); }
        assert!(stitcher.limited && stitcher.height() == MAX_HEIGHT);
    }

    #[test]
    fn 编码为不透明的普通图片() {
        let doc = document(50);
        let png = encode_png(&frame(&doc, 0, 50, &[], &[])).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        assert_eq!((info.width, info.height), (WIDTH as u32, 50));
        // BGRA 转为 RGBA：第 6 行第 1 个像素
        let source = &doc[5][..4];
        assert_eq!(&buffer[5 * WIDTH * 4..5 * WIDTH * 4 + 4], &[source[2], source[1], source[0], source[3]]);
    }

    #[test]
    fn 缩略图等比缩小且不复制整图() {
        let doc = document(200);
        let mut stitcher = Stitcher::new(0);
        stitcher.add(frame(&doc, 0, 200, &[], &[]));
        let small = stitcher.thumbnail(10, 1000);
        assert_eq!((small.width, small.height), (10, 50), "按宽度受限");
        let short = stitcher.thumbnail(100, 20);
        assert_eq!((short.width, short.height), (4, 20), "按高度受限");
        let same = stitcher.thumbnail(1000, 1000);
        assert_eq!((same.width, same.height), (WIDTH, 200), "不放大");
        assert_eq!(same.pixels, stitcher.compose().pixels, "原尺寸时像素不变");
    }
}
