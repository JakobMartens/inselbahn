require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const app = express();

// Simple CORS - allow everything for now
app.use(cors());
app.use(express.json());

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Initialize email transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587, // Standard SMTP port for STARTTLS
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false // Accept self-signed certificates
  }
});

// Verify transporter configuration
transporter.verify(function(error, success) {
  if (error) {
    console.log('Email transporter error:', error);
  } else {
    console.log('Email server is ready to send messages');
  }
});

console.log('Helgoland API starting...');

// Capacity limits
const ONLINE_CAPACITY = {
  UNTERLAND: 36,
  PREMIUM: 8
};

const SALESMAN_CAPACITY = {
  UNTERLAND: 45,
  PREMIUM: 11
};

// Test endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Helgoland Booking API',
    timestamp: new Date().toISOString()
  });
});

// Helper functions
const generateBookingCode = () => {
  return 'HE' + Math.random().toString(36).substr(2, 8).toUpperCase();
};

// Clean up expired reservations
const cleanupReservations = async () => {
  try {
    const { error } = await supabase
      .from('reservations')
      .delete()
      .lt('expires_at', new Date().toISOString());
    
    if (error) console.error('Cleanup error:', error);
  } catch (err) {
    console.error('Cleanup failed:', err);
  }
};

// Run cleanup every minute
setInterval(cleanupReservations, 60000);

// Check if booking is allowed (1 week advance, 1 hour before tour)
const isBookingAllowed = (tourDate, tourTime) => {
  const now = new Date();
  const tour = new Date(`${tourDate}T${tourTime}`);
  
  // Must be at least 1 hour in future
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  if (tour < oneHourFromNow) return false;
  
  // Must be within 7 days
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (tour > sevenDaysFromNow) return false;
  
  return true;
};

// Check if cancellation is allowed
const isCancellationAllowed = (tourDate, tourTime, totalPassengers) => {
  const now = new Date();
  const tour = new Date(`${tourDate}T${tourTime}`);
  const hoursUntilTour = (tour - now) / (1000 * 60 * 60);
  
  // Large groups (8+): 72 hours
  if (totalPassengers >= 8) {
    return hoursUntilTour >= 72;
  }
  
  // Standard: 24 hours
  return hoursUntilTour >= 24;
};

// Get actual booked seats (not limited by vehicle capacity)
const getBookedSeats = async (tourDate, tourTime, tourType) => {
  const { data: bookings } = await supabase
    .from('bookings')
    .select('adults, children, notes')
    .eq('tour_date', tourDate)
    .eq('tour_time', tourTime)
    .eq('tour_type', tourType)
    .eq('status', 'confirmed');
  
  let totalSeats = 0;
  (bookings || []).forEach(booking => {
    totalSeats += booking.adults + booking.children;
    // Check for wheelchair in notes
    if (booking.notes && booking.notes.includes('Rollstuhl')) {
      // Count wheelchair seats from notes - wheelchair takes 3 seats total
      const wheelchairMatch = booking.notes.match(/(\d+) Erwachsene \(Rollstuhl\)/);
      const wheelchairChildMatch = booking.notes.match(/(\d+) Kinder \(Rollstuhl\)/);
      if (wheelchairMatch) totalSeats += parseInt(wheelchairMatch[1]) * 2; // 3 total - 1 already counted
      if (wheelchairChildMatch) totalSeats += parseInt(wheelchairChildMatch[1]) * 2;
    }
  });
  
  return totalSeats;
};

// Get tour statistics
const getTourStatistics = async (tourType, startDate, endDate) => {
  const { data: bookings } = await supabase
    .from('bookings')
    .select('*')
    .eq('tour_type', tourType)
    .eq('status', 'confirmed')
    .gte('tour_date', startDate)
    .lte('tour_date', endDate);
  
  // Group by time slot
  const timeSlotStats = {};
  const tourConfig = tourType === 'UNTERLAND' ? 
    { times: ['13:30', '14:30'] } : 
    { times: ['10:30', '12:30', '14:15', '16:00'] };
  
  // Initialize stats for each time slot
  tourConfig.times.forEach(time => {
    timeSlotStats[time] = {
      totalTours: 0,
      totalPassengers: 0,
      totalRevenue: 0,
      tours: []
    };
  });
  
  // Process bookings
  bookings.forEach(booking => {
    const time = booking.tour_time.substring(0, 5);
    if (timeSlotStats[time]) {
      const passengers = booking.adults + booking.children;
      timeSlotStats[time].totalPassengers += passengers;
      timeSlotStats[time].totalRevenue += booking.total_amount / 100;
      
      // Check if this tour date already exists
      let tour = timeSlotStats[time].tours.find(t => t.date === booking.tour_date);
      if (!tour) {
        tour = { date: booking.tour_date, passengers: 0, bookings: 0, revenue: 0 };
        timeSlotStats[time].tours.push(tour);
      }
      tour.passengers += passengers;
      tour.bookings += 1;
      tour.revenue += booking.total_amount / 100;
    }
  });
  
  // Calculate averages
  Object.keys(timeSlotStats).forEach(time => {
    const stats = timeSlotStats[time];
    stats.totalTours = stats.tours.length;
    stats.averagePassengers = stats.totalTours > 0 ? 
      (stats.totalPassengers / stats.totalTours).toFixed(2) : 0;
    stats.averageRevenue = stats.totalTours > 0 ? 
      (stats.totalRevenue / stats.totalTours).toFixed(2) : 0;
  });
  
  return timeSlotStats;
};

// Get availability for a specific date
app.get('/api/availability/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const { tourType } = req.query;
    
    console.log(`Getting availability for ${tourType} on ${date}`);
    
    // Clean up first
    await cleanupReservations();
    
    // Get tour configuration
    const { data: tours, error: tourError } = await supabase
      .from('tours')
      .select('*')
      .eq('tour_type', tourType)
      .lte('valid_from', date)
      .or(`valid_until.is.null,valid_until.gte.${date}`)
      .order('valid_from', { ascending: false })
      .limit(1);
    
    if (tourError) {
      console.error('Tour error:', tourError);
      throw tourError;
    }
    
    if (!tours || tours.length === 0) {
      return res.status(404).json({ error: 'Keine Tour-Konfiguration gefunden' });
    }
    
    const tourConfig = tours[0];
    
    // Calculate availability for each time slot
    const availability = {};
    
    for (const time of tourConfig.times) {
      // Check if booking is allowed for this time
      const bookingAllowed = isBookingAllowed(date, time);
      
      // Get actual booked seats
      const bookedSeats = await getBookedSeats(date, time, tourType);
      const availableSeats = Math.max(0, ONLINE_CAPACITY[tourType] - bookedSeats);
      
      availability[time] = {
        totalSeats: availableSeats,
        vehicles: [], // Legacy support
        bookingAllowed,
        wheelchairAvailable: tourType === 'UNTERLAND',
        childrenFree: tourConfig.child_free_times?.includes(time) || false
      };
    }
    
    res.json({ 
      date,
      tourType,
      availability,
      prices: {
        adult: tourConfig.adult_price / 100,
        child: tourConfig.child_price / 100
      }
    });
    
  } catch (error) {
    console.error('Availability error:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Verfügbarkeit' });
  }
});

// Create reservation
app.post('/api/reservations', async (req, res) => {
  try {
    const { sessionId, tourDate, tourTime, tourType, seats } = req.body;
    
    // Check if booking is allowed
    if (!isBookingAllowed(tourDate, tourTime)) {
      return res.status(400).json({ error: 'Buchung nicht mehr möglich (weniger als 1 Stunde vor Tour oder mehr als 7 Tage im Voraus)' });
    }
    
    // Check online capacity
    const bookedSeats = await getBookedSeats(tourDate, tourTime, tourType);
    const availableSeats = ONLINE_CAPACITY[tourType] - bookedSeats;
    
    if (availableSeats < seats) {
      return res.status(400).json({ error: 'Keine verfügbaren Plätze' });
    }
    
    // Create reservation
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    const { data: reservation, error } = await supabase
      .from('reservations')
      .upsert({
        session_id: sessionId,
        tour_date: tourDate,
        tour_time: tourTime,
        vehicle_id: tourType, // Using tour type as vehicle ID for simplicity
        seats_reserved: seats,
        expires_at: expiresAt
      }, {
        onConflict: 'session_id,tour_date,tour_time'
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ 
      reservation,
      expiresAt 
    });
    
  } catch (error) {
    console.error('Reservation error:', error);
    res.status(500).json({ error: 'Fehler bei der Reservierung' });
  }
});

// Create booking
app.post('/api/bookings', async (req, res) => {
  try {
    const {
      sessionId,
      tourType,
      tourDate,
      tourTime,
      customerName,
      customerEmail,
      customerPhone,
      adults,
      children,
      babies, // Free under 6
      wheelchairAdults,
      wheelchairChildren,
      skipReservationCheck, // For salesman direct sales
      salesmanBooking, // Flag for salesman booking with higher capacity
      invoiceRequested,
      invoiceData,
      paymentMethod, // bar, sumup, rechnung
      paymentStatus // can override default
    } = req.body;
    
    // Check capacity based on booking type
    const capacity = salesmanBooking ? SALESMAN_CAPACITY[tourType] : ONLINE_CAPACITY[tourType];
    const bookedSeats = await getBookedSeats(tourDate, tourTime, tourType);
    
    // Calculate seats needed
    let seatsNeeded = adults + children; // Babies don't count
    seatsNeeded += (wheelchairAdults || 0) * 3; // Each wheelchair needs 3 seats
    seatsNeeded += (wheelchairChildren || 0) * 3;
    
    if (bookedSeats + seatsNeeded > capacity) {
      return res.status(400).json({ 
        error: `Keine verfügbaren Plätze (${bookedSeats + seatsNeeded} von ${capacity} Plätzen belegt)` 
      });
    }
    
    // Check reservation for online bookings
    if (!skipReservationCheck) {
      const { data: reservation } = await supabase
        .from('reservations')
        .select('*')
        .eq('session_id', sessionId)
        .eq('tour_date', tourDate)
        .eq('tour_time', tourTime)
        .gt('expires_at', new Date().toISOString())
        .single();
      
      if (!reservation) {
        return res.status(400).json({ error: 'Reservierung abgelaufen' });
      }
    }
    
    // Get tour config for pricing
    const { data: tours } = await supabase
      .from('tours')
      .select('*')
      .eq('tour_type', tourType)
      .lte('valid_from', tourDate)
      .order('valid_from', { ascending: false })
      .limit(1);
    
    const tourConfig = tours[0];
    
    // Calculate price (babies are free)
    let totalAmount = (adults + (wheelchairAdults || 0)) * tourConfig.adult_price;
    if (!tourConfig.child_free_times?.includes(tourTime)) {
      totalAmount += (children + (wheelchairChildren || 0)) * tourConfig.child_price;
    }
    
    // Determine payment status
    let finalPaymentStatus = 'paid';
    if (paymentStatus) {
      finalPaymentStatus = paymentStatus;
    } else if (skipReservationCheck && paymentMethod === 'rechnung') {
      finalPaymentStatus = 'pending';
    } else if (!skipReservationCheck) {
      finalPaymentStatus = 'pending'; // Online bookings start as pending
    }
    
    // Build notes array
    const notesArray = [];
    if (babies > 0) notesArray.push(`${babies} Kleinkinder (unter 6)`);
    if (wheelchairAdults > 0) notesArray.push(`${wheelchairAdults} Erwachsene (Rollstuhl)`);
    if (wheelchairChildren > 0) notesArray.push(`${wheelchairChildren} Kinder (Rollstuhl)`);
    if (paymentMethod) {
      const paymentMethodText = {
        'bar': 'Bar',
        'sumup': 'SumUp',
        'rechnung': 'Auf Rechnung'
      }[paymentMethod] || paymentMethod;
      notesArray.push(`Zahlung: ${paymentMethodText}`);
    }
    if (invoiceRequested) notesArray.push('Rechnung angefordert');
    if (salesmanBooking) notesArray.push('Verkauf vor Ort');
    
    // Determine vehicle ID (for backward compatibility)
    let vehicleId = tourType === 'UNTERLAND' ? 'U1' : 'P0';
    
    // Create booking
    const bookingCode = generateBookingCode();
    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({
        booking_code: bookingCode,
        tour_type: tourType,
        tour_date: tourDate,
        tour_time: tourTime,
        vehicle_id: vehicleId,
        customer_name: customerName || 'Vor-Ort Verkauf',
        customer_email: customerEmail || (salesmanBooking ? 'vor-ort@helgolandbahn.de' : null),
        customer_phone: customerPhone,
        adults: adults + (wheelchairAdults || 0),
        children: children + (wheelchairChildren || 0),
        total_amount: totalAmount,
        status: 'confirmed',
        payment_status: finalPaymentStatus,
        notes: notesArray.length > 0 ? notesArray.join(', ') : null
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Store invoice data if provided
    if (invoiceRequested && invoiceData) {
      const invoiceNote = `Rechnung an: ${invoiceData.company}` + 
        (invoiceData.taxId ? `, StNr: ${invoiceData.taxId}` : '') +
        (invoiceData.street ? `, ${invoiceData.street}` : '') +
        (invoiceData.city ? `, ${invoiceData.city}` : '');
      
      await supabase
        .from('bookings')
        .update({ 
          notes: booking.notes ? `${booking.notes} | ${invoiceNote}` : invoiceNote 
        })
        .eq('id', booking.id);
    }
    
    // Delete reservation if it exists
    if (!skipReservationCheck) {
      await supabase
        .from('reservations')
        .delete()
        .eq('session_id', sessionId)
        .eq('tour_date', tourDate)
        .eq('tour_time', tourTime);
    }
    
    res.json({ 
      booking,
      totalAmount: totalAmount / 100
    });
    
  } catch (error) {
    console.error('Booking error:', error);
    res.status(500).json({ error: 'Fehler bei der Buchung' });
  }
});

// Cancel booking
app.post('/api/bookings/cancel', async (req, res) => {
  try {
    const { bookingCode, email } = req.body;
    
    // Get booking
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_code', bookingCode)
      .eq('customer_email', email)
      .eq('status', 'confirmed')
      .single();
    
    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Buchung nicht gefunden' });
    }
    
    // Check cancellation policy
    const totalPassengers = booking.adults + booking.children;
    if (!isCancellationAllowed(booking.tour_date, booking.tour_time, totalPassengers)) {
      const minHours = totalPassengers >= 8 ? 72 : 24;
      return res.status(400).json({ 
        error: `Stornierung muss mindestens ${minHours} Stunden vor Tourbeginn erfolgen` 
      });
    }
    
    // Update booking status
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ 
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', booking.id);
    
    if (updateError) throw updateError;
    
    res.json({ success: true, message: 'Buchung erfolgreich storniert' });
    
  } catch (error) {
    console.error('Cancellation error:', error);
    res.status(500).json({ error: 'Fehler bei der Stornierung' });
  }
});

// Driver endpoint - get tours
app.get('/api/driver/tours', async (req, res) => {
  try {
    const { date, vehicleId } = req.query;
    
    console.log(`Getting tours for vehicle ${vehicleId} on ${date}`);
    
    // Map vehicle ID to tour type
    const tourType = vehicleId === 'U1' ? 'UNTERLAND' : 'PREMIUM';
    
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('tour_date', date)
      .eq('tour_type', tourType)
      .eq('status', 'confirmed')
      .order('tour_time');
    
    if (error) throw error;
    
    // Group by time
    const toursByTime = {};
    bookings.forEach(booking => {
      const time = booking.tour_time;
      if (!toursByTime[time]) {
        toursByTime[time] = {
          time,
          tourType: booking.tour_type,
          passengers: []
        };
      }
      
      toursByTime[time].passengers.push({
        name: booking.customer_name,
        adults: booking.adults,
        children: booking.children,
        notes: booking.notes
      });
    });
    
    res.json({ 
      date,
      vehicleId,
      tours: Object.values(toursByTime) 
    });
    
  } catch (error) {
    console.error('Driver tours error:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Touren' });
  }
});

// Salesman endpoints
app.get('/api/salesman/availability', async (req, res) => {
  try {
    const { date = new Date().toISOString().split('T')[0] } = req.query;
    
    // Get all tour types
    const tourTypes = ['UNTERLAND', 'PREMIUM'];
    const availability = {};
    
    for (const tourType of tourTypes) {
      const { data: tours } = await supabase
        .from('tours')
        .select('*')
        .eq('tour_type', tourType)
        .lte('valid_from', date)
        .or(`valid_until.is.null,valid_until.gte.${date}`)
        .limit(1);
      
      if (!tours || tours.length === 0) continue;
      
      const tourConfig = tours[0];
      
      availability[tourType] = {
        times: {},
        prices: {
          adult: tourConfig.adult_price / 100,
          child: tourConfig.child_price / 100
        }
      };
      
      for (const time of tourConfig.times) {
        const bookedSeats = await getBookedSeats(date, time, tourType);
        const onlineCapacity = ONLINE_CAPACITY[tourType];
        const onlineAvailable = Math.max(0, onlineCapacity - bookedSeats);
        
        availability[tourType].times[time] = {
          available: onlineAvailable,
          capacity: onlineCapacity,
          childrenFree: tourConfig.child_free_times?.includes(time) || false
        };
      }
    }
    
    res.json({ date, availability });
    
  } catch (error) {
    console.error('Salesman availability error:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Verfügbarkeit' });
  }
});

// Get bookings with filters
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const { startDate, endDate, status, tourType, paymentStatus } = req.query;
    
    let query = supabase
      .from('bookings')
      .select('*')
      .order('tour_date', { ascending: false })
      .order('tour_time', { ascending: false });
    
    if (startDate) query = query.gte('tour_date', startDate);
    if (endDate) query = query.lte('tour_date', endDate);
    if (status) query = query.eq('status', status);
    if (tourType) query = query.eq('tour_type', tourType);
    if (paymentStatus) query = query.eq('payment_status', paymentStatus);
    
    const { data: bookings, error } = await query;
    
    // Sort bookings by date and time
    if (bookings) {
        bookings.sort((a, b) => {
            const dateA = new Date(a.tour_date + ' ' + a.tour_time);
            const dateB = new Date(b.tour_date + ' ' + b.tour_time);
            return dateB - dateA; // Newest first
        });
    }
    
    if (error) throw error;
    
    res.json({ bookings });
    
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Buchungen' });
  }
});

// Get statistics with enhanced tour analytics
app.get('/api/admin/statistics', async (req, res) => {
  try {
    const { year, month } = req.query;
    
    let startDate, endDate;
    
    if (month) {
      // Specific month
      startDate = `${year}-${month.padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${year}-${month.padStart(2, '0')}-${lastDay}`;
    } else if (year) {
      // Full year
      startDate = `${year}-01-01`;
      endDate = `${year}-12-31`;
    } else {
      // Current year
      const currentYear = new Date().getFullYear();
      startDate = `${currentYear}-01-01`;
      endDate = `${currentYear}-12-31`;
    }
    
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .gte('tour_date', startDate)
      .lte('tour_date', endDate)
      .eq('status', 'confirmed');
    
    if (error) throw error;
    
    // Calculate statistics
    const stats = {
      totalBookings: bookings.length,
      totalRevenue: 0,
      totalPassengers: 0,
      byTourType: {},
      byPaymentMethod: {},
      byMonth: {},
      dailyRevenue: {},
      tourStatistics: {
        UNTERLAND: await getTourStatistics('UNTERLAND', startDate, endDate),
        PREMIUM: await getTourStatistics('PREMIUM', startDate, endDate)
      },
      popularTimes: {},
      occupancyRates: {}
    };
    
    // Initialize payment methods
    const paymentMethods = ['online', 'bar', 'sumup', 'rechnung'];
    paymentMethods.forEach(method => {
      stats.byPaymentMethod[method] = {
        count: 0,
        revenue: 0
      };
    });
    
    // Initialize tour statistics
    ['UNTERLAND', 'PREMIUM'].forEach(tourType => {
      stats.popularTimes[tourType] = {};
      stats.occupancyRates[tourType] = {};
    });
    
    bookings.forEach(booking => {
      const revenue = booking.total_amount / 100;
      const passengers = booking.adults + booking.children;
      const month = booking.tour_date.substring(0, 7);
      const paymentMethod = booking.notes?.includes('Bar') ? 'bar' :
                          booking.notes?.includes('SumUp') ? 'sumup' :
                          booking.notes?.includes('Auf Rechnung') ? 'rechnung' : 'online';
      const time = booking.tour_time.substring(0, 5);
      
      // Total stats
      stats.totalRevenue += revenue;
      stats.totalPassengers += passengers;
      
      // By tour type
      if (!stats.byTourType[booking.tour_type]) {
        stats.byTourType[booking.tour_type] = {
          count: 0,
          revenue: 0,
          passengers: 0,
          averageGroupSize: 0
        };
      }
      stats.byTourType[booking.tour_type].count++;
      stats.byTourType[booking.tour_type].revenue += revenue;
      stats.byTourType[booking.tour_type].passengers += passengers;
      
      // By payment method
      stats.byPaymentMethod[paymentMethod].count++;
      stats.byPaymentMethod[paymentMethod].revenue += revenue;
      
      // By month
      if (!stats.byMonth[month]) {
        stats.byMonth[month] = {
          count: 0,
          revenue: 0,
          passengers: 0
        };
      }
      stats.byMonth[month].count++;
      stats.byMonth[month].revenue += revenue;
      stats.byMonth[month].passengers += passengers;
      
      // Daily revenue
      if (!stats.dailyRevenue[booking.tour_date]) {
        stats.dailyRevenue[booking.tour_date] = {
          total: 0,
          byPaymentMethod: {}
        };
        paymentMethods.forEach(method => {
          stats.dailyRevenue[booking.tour_date].byPaymentMethod[method] = 0;
        });
      }
      stats.dailyRevenue[booking.tour_date].total += revenue;
      stats.dailyRevenue[booking.tour_date].byPaymentMethod[paymentMethod] += revenue;
      
      // Popular times
      if (!stats.popularTimes[booking.tour_type][time]) {
        stats.popularTimes[booking.tour_type][time] = 0;
      }
      stats.popularTimes[booking.tour_type][time] += passengers;
    });
    
    // Calculate averages
    Object.keys(stats.byTourType).forEach(tourType => {
      const tourStats = stats.byTourType[tourType];
      tourStats.averageGroupSize = tourStats.count > 0 ? 
        (tourStats.passengers / tourStats.count).toFixed(2) : 0;
      tourStats.averageRevenue = tourStats.count > 0 ?
        (tourStats.revenue / tourStats.count).toFixed(2) : 0;
    });
    
    // Calculate occupancy rates
    const capacities = {
      UNTERLAND: { capacity: 45, times: ['13:30', '14:30'] },
      PREMIUM: { capacity: 11, times: ['10:30', '12:30', '14:15', '16:00'] }
    };
    
    Object.keys(capacities).forEach(tourType => {
      const tourInfo = capacities[tourType];
      tourInfo.times.forEach(time => {
        const tourStats = stats.tourStatistics[tourType][time];
        if (tourStats && tourStats.totalTours > 0) {
          const totalCapacity = tourInfo.capacity * tourStats.totalTours;
          const occupancyRate = (tourStats.totalPassengers / totalCapacity * 100).toFixed(1);
          stats.occupancyRates[tourType][time] = occupancyRate;
        } else {
          stats.occupancyRates[tourType][time] = 0;
        }
      });
    });
    
    res.json({ statistics: stats });
    
  } catch (error) {
    console.error('Statistics error:', error);
    res.status(500).json({ error: 'Fehler beim Abrufen der Statistiken' });
  }
});

// Send custom email to booking
app.post('/api/admin/send-email', async (req, res) => {
  try {
    const { bookingId, subject, message } = req.body;
    
    // Get booking
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .single();
    
    if (error || !booking) {
      return res.status(404).json({ error: 'Buchung nicht gefunden' });
    }
    
    if (!booking.customer_email || booking.customer_email === 'vor-ort@helgolandbahn.de') {
      return res.status(400).json({ error: 'Keine E-Mail-Adresse hinterlegt' });
    }
    
    // Send email
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: booking.customer_email,
      subject: subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>${subject}</h2>
          <p>Sehr geehrte/r ${booking.customer_name},</p>
          <div style="margin: 20px 0;">
            ${message.replace(/\n/g, '<br>')}
          </div>
          <hr style="margin: 30px 0;">
          <p style="color: #666; font-size: 14px;">
            Ihre Buchungsdetails:<br>
            Buchungscode: ${booking.booking_code}<br>
            Tour: ${booking.tour_type === 'UNTERLAND' ? 'Unterland-Tour' : 'Premium-Tour'}<br>
            Datum: ${new Date(booking.tour_date).toLocaleDateString('de-DE')}<br>
            Uhrzeit: ${booking.tour_time}
          </p>
          <p style="color: #666; font-size: 14px;">
            Mit freundlichen Grüßen<br>
            Ihr Team der Inselbahn Rundfahrten Helgoland
          </p>
        </div>
      `
    });
    
    res.json({ success: true, message: 'E-Mail erfolgreich gesendet' });
    
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ error: 'Fehler beim Senden der E-Mail' });
  }
});

// Cancel booking by admin
app.post('/api/admin/cancel-booking', async (req, res) => {
  try {
    const { bookingId, sendEmail, emailMessage } = req.body;
    
    // Get booking
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .eq('status', 'confirmed')
      .single();
    
    if (fetchError || !booking) {
      return res.status(404).json({ error: 'Buchung nicht gefunden' });
    }
    
    // Update booking status
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ 
        status: 'cancelled',
        updated_at: new Date().toISOString()
      })
      .eq('id', booking.id);
    
    if (updateError) throw updateError;
    
    // Send cancellation email if requested
    if (sendEmail && booking.customer_email && booking.customer_email !== 'vor-ort@helgolandbahn.de') {
      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: booking.customer_email,
        subject: 'Stornierung Ihrer Buchung - Inselbahn Rundfahrten Helgoland',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Stornierung Ihrer Buchung</h2>
            <p>Sehr geehrte/r ${booking.customer_name},</p>
            <div style="margin: 20px 0;">
              ${emailMessage ? emailMessage.replace(/\n/g, '<br>') : 'Ihre Buchung wurde storniert.'}
            </div>
            <hr style="margin: 30px 0;">
            <p style="color: #666; font-size: 14px;">
              Stornierte Buchung:<br>
              Buchungscode: ${booking.booking_code}<br>
              Tour: ${booking.tour_type === 'UNTERLAND' ? 'Unterland-Tour' : 'Premium-Tour'}<br>
              Datum: ${new Date(booking.tour_date).toLocaleDateString('de-DE')}<br>
              Uhrzeit: ${booking.tour_time}
            </p>
            <p style="color: #666; font-size: 14px;">
              Bei Fragen stehen wir Ihnen gerne zur Verfügung.<br><br>
              Mit freundlichen Grüßen<br>
              Ihr Team der Inselbahn Rundfahrten Helgoland
            </p>
          </div>
        `
      });
    }
    
    res.json({ success: true, message: 'Buchung erfolgreich storniert' });
    
  } catch (error) {
    console.error('Admin cancellation error:', error);
    res.status(500).json({ error: 'Fehler bei der Stornierung' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('API endpoints available:');
  console.log(`- Health: /api/health`);
  console.log(`- Availability: /api/availability/:date?tourType=PREMIUM`);
  console.log(`- Driver tours: /api/driver/tours?date=YYYY-MM-DD&vehicleId=XX`);
  console.log(`- Salesman availability: /api/salesman/availability?date=YYYY-MM-DD`);
  console.log(`- Admin bookings: /api/admin/bookings`);
  console.log(`- Admin statistics: /api/admin/statistics`);
  console.log(`- Self-service cancellation: /api/bookings/cancel`);
});
